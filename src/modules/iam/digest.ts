// The owner's monthly digest (BL-PAY-021; pay-to-be.md BR-PAY-020 "الملخص الشهري", DEC-PO-018 / 022 / 144, RT-PAY-704,
// RT-PAY-709, RT-PAY-1205; ADR-0009). Radeef sends it from outside the tenant to the owner's contact that Radeef
// registered from the formal request (TenantNamedPerson OWNER_CONTACT, ADR-0008): no tenant user can choose or
// change the recipient, and nothing in it is a secret (no IBAN, amount, password, link or code).
//
// The controls mode is per legal company (DEC-PO-144), so the digest has one block PER COMPANY, most important first
// within it (RT-PAY-709: the real exceptions are not drowned in routine):
//   1. المستفيد = المشغّل      acts done alone on the operator's own money or own request (SELF_BENEFICIARY);
//   2. معتمد واحد              the other acts done alone because no second person existed;
//   3. بانتظار تأكيدك          classifications waiting for the owner's confirmation (through Radeef until G8);
//   4. وضع الضوابط             the company's readiness, its mode now and the changes of the month;
//   5. مسارات الموافقة          BL-WFE-003 (wfe-to-be.md §12.1, §12.2): the approval paths activated or retired that
//                              loosened a control (platform CONTROL_RELAXED), and the requests approved by a path with
//                              no human stage (AUTO_APPROVED_BY_DEFINITION). The engine's decisions and activations
//                              taken alone in SINGLE_OPERATOR are SELF_ACT records, so they are in sections 1 and 2;
// then, for the whole tenant (accounts are tenant-wide):
//   6. الهوية والصلاحيات        attestations (the root's included) and the other identity changes;
//   7. العمليات المالية         counts of the money operations and of the refused attempts (context only).
//
// The job (owner-digest, daily, cross-company: the owner is one per tenant, §5.4.3 "ملخص المالك المجمع"):
// records the controls mode of every marked company (recordControlsMode), then builds the digest of the PREVIOUS
// month and queues it once to NotificationOutbox (the key names the month and the contact). It never sends: the
// outbox dispatcher does, when the email provider is configured (G8 / SES via SMTP); until then nothing leaves the
// host, the job records why, and Radeef reads the queued digest with the vendor CLI (`digest`). DEC-PO-144: while a
// ready company is SINGLE_OPERATOR and Radeef has registered no owner contact, the job FAILS (monitoring sees it).
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  AUTO_APPROVED_ACTION,
  audit,
  auditActionCounts,
  auditCountsByCompany,
  auditRecordsOf,
  controlRelaxationRecords,
  discrepancySelfActCounts,
  emitEvent,
  enqueueEmails,
  eventsOf,
  isOutboxEmailAddress,
  moneyOperations,
  outboxByPrefix,
  outboxSendConfig,
  pendingOwnerConfirmations,
  selfActRecords,
  type JobDefinition,
  type JobEnv,
  type OperatorMode,
  type ControlRelaxationRecord,
  type Period,
  type RootClient,
  type SelfActRecord,
} from '@/modules/platform';
import { CONTROLS_AGGREGATE_TYPE, CONTROLS_MODE_CHANGED_EVENT, controlsOfCompanies, readyCompanies, recordControlsMode, type CompanyControls } from './controls';
import type { SystemContext } from './context';
import { isFinancialApproverRole } from './identity';

type Db = PrismaClient | Prisma.TransactionClient;

export const OWNER_DIGEST_JOB = 'owner-digest';
export const OWNER_DIGEST_QUEUED_EVENT = 'iam.ownerDigest.queued';
export const OWNER_DIGEST_KEY_PREFIX = 'owner-digest:';
/** Lines listed per section; the rest is counted. */
export const DIGEST_SECTION_LINES = 60;

/** The companies' display names, injected by the composition root (org sits above iam; iam does not read Company). */
export type CompanyNames = (db: Db, companyIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;

/** Asia/Riyadh has no daylight saving: UTC+3 all year. */
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

export interface DigestMonth {
  year: number;
  month: number;
}

/** The month before the Riyadh month of `now`. */
export function previousMonth(now: Date): DigestMonth {
  const local = new Date(now.getTime() + RIYADH_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth() + 1;
  return m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 };
}

/** [first instant, first instant of the next month) of a Riyadh month, in UTC. */
export function monthPeriod(m: DigestMonth): Period {
  if (!Number.isInteger(m.year) || !Number.isInteger(m.month) || m.month < 1 || m.month > 12 || m.year < 2000 || m.year > 2200) {
    throw Object.assign(new Error('شهر الملخص غير صالح'), { status: 400 });
  }
  const from = new Date(Date.UTC(m.year, m.month - 1, 1) - RIYADH_OFFSET_MS);
  const to = new Date(Date.UTC(m.month === 12 ? m.year + 1 : m.year, m.month === 12 ? 0 : m.month, 1) - RIYADH_OFFSET_MS);
  return { from, to };
}

export function monthLabel(m: DigestMonth): string {
  return `${m.year}-${String(m.month).padStart(2, '0')}`;
}

/** The outbox key of one month's digest to one owner contact (a new contact gets the month again). */
export function ownerDigestKey(m: DigestMonth, contactId: string): string {
  return `${OWNER_DIGEST_KEY_PREFIX}${monthLabel(m)}:${contactId}`;
}

/** The owner's contact registered by Radeef (DEC-PO-022), or null. */
export async function ownerContactOf(db: Db): Promise<{ id: string; email: string | null; mobile: string | null; name: string | null } | null> {
  return db.tenantNamedPerson.findFirst({ where: { kind: 'OWNER_CONTACT', revokedAt: null }, orderBy: { addedAt: 'desc' }, select: { id: true, email: true, mobile: true, name: true } });
}

const REASON_AR: Readonly<Record<string, string>> = Object.freeze({
  SELF_BENEFICIARY: 'المنفّذ هو المستفيد',
  PAYER_IS_APPROVER: 'الصارف هو المعتمد',
  SAME_PERSON_TWICE: 'الطالب هو المعتمد',
  UNKNOWN_APPROVER: 'لا معتمد مسجَّل',
  CREATOR_IS_SECOND_PERSON: 'الشخص الثاني هو منشئ الحساب',
  UNATTESTED_SECOND_PERSON: 'الشخص الثاني غير مُقرّ بهويته',
  // The approval engine (BL-WFE-003).
  ONE_PERSON_TWO_STEPS: 'شخص واحد في خطوتين يلزم فيهما شخصان',
  UNATTESTED_APPROVER: 'المعتمد غير مُقرّ بهويته',
  AUTHOR_ACTIVATED: 'من كتب مسار الموافقة هو من فعّله',
  AUTHOR_RETIRED: 'من طلب إيقاف مسار الموافقة هو من أكّده',
});

/** The loosened controls of an approval path (workflow RelaxationCode), as the owner reads them. */
const RELAXATION_AR: Readonly<Record<string, string>> = Object.freeze({
  AUTO_APPROVE_PATH: 'طريق يُعتمد فيه الطلب آلياً دون معتمد',
  FEWER_HUMAN_STAGES: 'معتمدون أقل',
  REJECT_PAIR_REMOVED: 'لم يعد الرفض يحتاج شخصاً ثانياً',
  REJECT_AUTHORITY_WIDENED: 'أدوار أكثر تملك الرفض',
  DISTINCT_FROM_PRIOR_REMOVED: 'لم يعد يُشترط معتمد مختلف عمن قبله',
  PARALLEL_ALL_REMOVED: 'موافقة واحد بدل موافقة الجميع',
  COVER_ROLE_CHANGED: 'تغيّر دور التغطية',
});

const MODE_AR: Readonly<Record<OperatorMode, string>> = Object.freeze({
  SINGLE_OPERATOR: 'المشغّل الواحد',
  ENFORCED: 'الضوابط الكاملة (شخصان مُقرّ بهما أو أكثر)',
});

/** Who did it, as the owner reads it: the account's display name, else its email (the owner's own staff). */
async function namesOf(db: Db, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map();
  const rows = await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true, email: true } });
  return new Map(rows.map((r) => [r.id, r.name?.trim() || r.email]));
}

function day(d: Date): string {
  return new Date(d.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
}

function short(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : '—';
}

function capped(lines: string[], total: number): string[] {
  if (total <= DIGEST_SECTION_LINES) return lines;
  return [...lines.slice(0, DIGEST_SECTION_LINES), `… و${total - DIGEST_SECTION_LINES} أخرى (تفاصيلها في سجل التدقيق لدى رديف)`];
}

export interface ModeSpan {
  /** The mode at the start of the month (null: not recorded yet then). */
  atStart: OperatorMode | null;
  /** The changes recorded inside the month. */
  changes: { at: Date; from: OperatorMode | null; to: OperatorMode; approvers: number | null }[];
  /** SINGLE_OPERATOR was recorded at some time of the month. */
  singleDuringMonth: boolean;
}

function modeOf(v: unknown): OperatorMode | null {
  return v === 'ENFORCED' || v === 'SINGLE_OPERATOR' ? v : null;
}

/** The recorded controls mode of a company over a month, from its iam.controls.modeChanged events. */
export async function modeSpanOf(db: Db, period: Period, companyId: string): Promise<ModeSpan> {
  const events = await eventsOf(db, { aggregateType: CONTROLS_AGGREGATE_TYPE, aggregateId: companyId, type: CONTROLS_MODE_CHANGED_EVENT }, 5000);
  let atStart: OperatorMode | null = null;
  const changes: ModeSpan['changes'] = [];
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.occurredAt < period.from) atStart = modeOf(p.to) ?? atStart;
    else if (e.occurredAt < period.to) changes.push({ at: e.occurredAt, from: modeOf(p.from), to: modeOf(p.to) ?? 'ENFORCED', approvers: typeof p.approvers === 'number' ? p.approvers : null });
  }
  return { atStart, changes, singleDuringMonth: atStart === 'SINGLE_OPERATOR' || changes.some((c) => c.to === 'SINGLE_OPERATOR') };
}

/** Identity audit actions listed by name in section 5 (attestations completed). */
const ATTESTATION_ACTIONS = ['iam.identity.attest', 'iam.identity.completeCredentialSetup'] as const;
/** Identity audit actions counted in section 5 (everything an admin or Radeef did to accounts). */
const IDENTITY_PREFIXES = ['iam.identity.', 'iam.vendor.', 'iam.user.'] as const;
/** Not changes of anyone's controls: a typed code. */
const IDENTITY_NOISE = new Set(['iam.identity.credentialAttempt']);

export interface DigestCounts {
  selfBeneficiary: number;
  singleApprover: number;
  pendingConfirmations: number;
  modeChanges: number;
  /** BL-WFE-003: approval-path changes that loosened a control, and requests approved with no human stage. */
  relaxedControls: number;
  autoApprovals: number;
  attestations: number;
  identityChanges: number;
  moneyOperations: number;
  blockedAttempts: number;
}

export interface CompanyDigest {
  /** null: records without a company (a tenant-level finding, an act whose company is unknown). */
  companyId: string | null;
  name: string;
  controls: CompanyControls | null;
  span: ModeSpan | null;
  counts: Pick<DigestCounts, 'selfBeneficiary' | 'singleApprover' | 'pendingConfirmations' | 'modeChanges' | 'relaxedControls' | 'autoApprovals'>;
}

export interface OwnerDigest {
  month: DigestMonth;
  period: Period;
  companies: CompanyDigest[];
  counts: DigestCounts;
  /** Worth sending: a company SINGLE_OPERATOR during the month, or any of sections 1 to 6 is not empty. */
  reportable: boolean;
  subject: string;
  body: string;
}

function isSelfBeneficiary(r: SelfActRecord): boolean {
  return r.reasons.includes('SELF_BENEFICIARY');
}

/** Builds one month's digest (read only). `companyNames`: the composition root's display names (else short ids). */
export async function buildOwnerDigest(db: Db, month: DigestMonth, opts: { companyNames?: CompanyNames } = {}): Promise<OwnerDigest> {
  const period = monthPeriod(month);
  const selfActs = await selfActRecords(db, period);
  const discrepancyActs = await discrepancySelfActCounts(db, period);
  const pending = await pendingOwnerConfirmations(db);
  const ready = await readyCompanies(db);
  const changedEvents = await db.controlsReadiness.findMany({ distinct: ['companyId'], select: { companyId: true } });
  const relaxed: ControlRelaxationRecord[] = await controlRelaxationRecords(db, period);
  const autoApproved = await auditCountsByCompany(db, period, [AUTO_APPROVED_ACTION]);

  // The companies of the digest: every company Radeef ever marked, and every company a record of the month names.
  const keyOf = (c: string | null | undefined) => c ?? '';
  const ids = new Set<string>([
    ...ready.map((r) => r.companyId),
    ...changedEvents.map((r) => r.companyId),
    ...selfActs.map((r) => keyOf(r.companyId)),
    ...discrepancyActs.map((r) => keyOf(r.companyId)),
    ...pending.map((p) => keyOf(p.companyId)),
    ...relaxed.map((r) => keyOf(r.companyId)),
    ...autoApproved.map((r) => keyOf(r.companyId)),
  ]);
  const realIds = [...ids].filter(Boolean).sort();
  const controls = new Map((await controlsOfCompanies(db, realIds)).map((c) => [c.companyId, c]));
  const names = opts.companyNames ? await opts.companyNames(db, realIds) : new Map<string, string>();
  const spans = new Map<string, ModeSpan>();
  for (const id of realIds) spans.set(id, await modeSpanOf(db, period, id));

  const attestRows = await auditRecordsOf(db, period, ATTESTATION_ACTIONS, 1000);
  const attestations = attestRows.filter((r) => {
    const a = (r.after ?? {}) as Record<string, unknown>;
    return r.action === 'iam.identity.attest' || a.purpose === 'FIRST_ATTESTATION';
  });
  const identityCounts = Object.fromEntries(Object.entries(await auditActionCounts(db, period, { prefixes: IDENTITY_PREFIXES })).filter(([a]) => !IDENTITY_NOISE.has(a)));
  const moneyNames = moneyOperations().filter((o) => o.owner !== 'iam' && !o.name.startsWith('test.')).map((o) => o.name);
  const moneyCounts = await auditActionCounts(db, period, { actions: moneyNames });
  const blocked = (await auditActionCounts(db, period, { actions: ['MONEY_GUARD_BLOCKED'] })).MONEY_GUARD_BLOCKED ?? 0;

  const people = await namesOf(db, [
    ...selfActs.map((r) => r.actorId),
    ...relaxed.map((r) => r.actorId),
    ...pending.map((p) => p.actedById),
    ...attestations.flatMap((r) => [r.actorId, r.entityId, ((r.after ?? {}) as Record<string, unknown>).identityAttestedById as string | undefined]),
  ]);
  const who = (id: string | null | undefined, type?: string) => (id ? (people.get(id) ?? `حساب ${short(id)}`) : type === 'SYSTEM' ? 'النظام' : '—');
  const roots = new Set((await db.user.findMany({ where: { tenantRoot: true }, select: { id: true } })).map((u) => u.id));
  const actLine = (r: SelfActRecord) =>
    `- ${day(r.occurredAt)} · ${r.operation}${r.entityId ? ` (${r.entityType} ${short(r.entityId)})` : ''} · ${who(r.actorId, r.actorType)} · ${r.reasons.map((x) => REASON_AR[x] ?? x).join('، ') || 'بلا شخص ثانٍ'}`;

  const ordered = [...realIds.sort((a, b) => (names.get(a) ?? a).localeCompare(names.get(b) ?? b)), ...(ids.has('') ? [''] : [])];
  const companies: CompanyDigest[] = [];
  const lines: string[] = [];
  const label = `${String(month.month).padStart(2, '0')}/${month.year}`;
  for (const id of ordered) {
    const companyId = id || null;
    const name = companyId ? (names.get(companyId) ?? `شركة ${short(companyId)}`) : 'بلا شركة محددة';
    const acts = selfActs.filter((r) => keyOf(r.companyId) === id);
    const own = acts.filter(isSelfBeneficiary);
    const routine = acts.filter((r) => !isSelfBeneficiary(r));
    const discrepancies = discrepancyActs.filter((r) => keyOf(r.companyId) === id).reduce((a, r) => a + r.count, 0);
    const waiting = pending.filter((p) => keyOf(p.companyId) === id);
    const c = companyId ? (controls.get(companyId) ?? null) : null;
    const span = companyId ? (spans.get(companyId) ?? null) : null;
    const loosened = relaxed.filter((r) => keyOf(r.companyId) === id);
    const autos = autoApproved.filter((r) => keyOf(r.companyId) === id).reduce((a, r) => a + r.count, 0);
    const counts = {
      selfBeneficiary: own.length,
      singleApprover: routine.length + discrepancies,
      pendingConfirmations: waiting.length,
      modeChanges: span?.changes.length ?? 0,
      relaxedControls: loosened.length,
      autoApprovals: autos,
    };
    companies.push({ companyId, name, controls: c, span, counts });
    lines.push(
      '',
      `■ ${name}`,
      c
        ? `وضع الضوابط الآن: ${c.ready ? MODE_AR[c.mode] : `${MODE_AR.ENFORCED} (لم تعلّم رديف الشركة جاهزة بعد)`} · المعتمدون المُقرّ بهم فيها: ${c.approvers}`
        : 'سجلات بلا شركة محددة (تُعامل بالضوابط الكاملة).',
      ...(span?.singleDuringMonth ? ['خلال الشهر كانت هذه الشركة في وضع المشغّل الواحد (كل الشهر أو بعضه): ما كان يحتاج شخصين نُفّذ بشخص واحد، وسُجّل، وهو مُدرج أدناه.'] : []),
      `١) المستفيد = المشغّل: عمليات نفّذها شخص على ماله هو أو اعتمد فيها طلبه هو (${own.length})`,
      ...(own.length ? capped(own.map(actLine), own.length) : ['- لا شيء']),
      `٢) معتمد واحد: عمليات نُفّذت دون شخص ثانٍ (${counts.singleApprover})`,
      ...(routine.length ? capped(routine.map(actLine), routine.length) : []),
      ...(discrepancies ? [`- شرح أو تنازل عن اختلاف في فحوص السلامة بشخص واحد: ${discrepancies}`] : []),
      ...(routine.length || discrepancies ? [] : ['- لا شيء']),
      `٣) بانتظار تأكيدك (${waiting.length})`,
      ...(waiting.length
        ? [
            ...capped(
              waiting.map((p) => `- ${p.ruleId} · رقم ${short(p.id)} · ${p.waiverReason ? 'تنازل' : 'شرح'}${p.pendingAction ? ' (موقوف حتى تأكيدك)' : ''} · ${who(p.actedById)} · ${p.actedAt ? day(p.actedAt) : '—'}`),
              waiting.length,
            ),
            'للتأكيد أو الرفض تواصل مع رديف عبر وسيلتك المسجلة لديها واذكر رقم البند. لا يُقبل التأكيد من داخل نظام الشركة.',
          ]
        : ['- لا شيء']),
      `٤) وضع الضوابط: التغييرات خلال الشهر (${counts.modeChanges})`,
      ...(span?.changes.length
        ? span.changes.map((ch) => `- ${day(ch.at)} · من ${ch.from ? MODE_AR[ch.from] : 'غير مسجّل'} إلى ${MODE_AR[ch.to]}${ch.approvers === null ? '' : ` (المعتمدون المُقرّ بهم: ${ch.approvers})`}`)
        : ['- لا تغيير']),
      `٥) مسارات الموافقة: تغييرات أرخت ضابطاً (${loosened.length})، وطلبات اعتُمدت آلياً دون معتمد (${autos})`,
      ...(loosened.length
        ? capped(
            loosened.map((r) => `- ${day(r.occurredAt)} · ${r.subject ?? r.entityType} · ${who(r.actorId, r.actorType)} · ${r.relaxations.map((x) => RELAXATION_AR[x] ?? x).join('، ') || '—'}`),
            loosened.length,
          )
        : ['- لا تغيير يرخي ضابطاً']),
    );
  }

  const sum = (k: keyof CompanyDigest['counts']) => companies.reduce((a, c) => a + c.counts[k], 0);
  const counts: DigestCounts = {
    selfBeneficiary: sum('selfBeneficiary'),
    singleApprover: sum('singleApprover'),
    pendingConfirmations: sum('pendingConfirmations'),
    modeChanges: sum('modeChanges'),
    relaxedControls: sum('relaxedControls'),
    autoApprovals: sum('autoApprovals'),
    attestations: attestations.length,
    identityChanges: Object.values(identityCounts).reduce((a, b) => a + b, 0),
    moneyOperations: Object.values(moneyCounts).reduce((a, b) => a + b, 0),
    blockedAttempts: blocked,
  };
  const singleDuringMonth = companies.some((c) => c.span?.singleDuringMonth);
  const reportable =
    singleDuringMonth || counts.selfBeneficiary + counts.singleApprover + counts.pendingConfirmations + counts.modeChanges + counts.relaxedControls + counts.autoApprovals + counts.identityChanges > 0;

  const body = [
    'السلام عليكم،',
    '',
    `هذا ملخص رديف الشهري لصاحب الشركة عن شهر ${label}. ترسله رديف إليك مباشرة من خارج نظام شركتك، ولا يستطيع أحد في الشركة إيقافه أو تغيير عنوانه.`,
    'وضع الضوابط يُحسب لكل شركة على حدة: «المشغّل الواحد» يعني أن ما يحتاج شخصين يُنفَّذ بشخص واحد ويُسجَّل ويصلك هنا.',
    ...lines,
    '',
    `٦) الهوية والصلاحيات (كل الشركات): إقرارات الهوية (${attestations.length})`,
    ...(attestations.length
      ? capped(
          attestations.map((r) => {
            const a = (r.after ?? {}) as Record<string, unknown>;
            const attester = (a.identityAttestedById as string | undefined) ?? r.actorId;
            const byRoot = attester ? roots.has(attester) : false;
            return `- ${day(r.occurredAt)} · أُقرّ ${who(r.entityId)} · المُقرّ: ${who(attester)}${byRoot ? ' (جذر الثقة)' : ''}${a.rootAttestOwn === true ? ' · ممن سمّيتهم في طلبك' : ''}`;
          }),
          attestations.length,
        )
      : ['- لا شيء']),
    'تغييرات الحسابات الأخرى (عددها):',
    ...(Object.keys(identityCounts).length ? Object.entries(identityCounts).map(([a, n]) => `- ${a}: ${n}`) : ['- لا شيء']),
    '',
    `٧) العمليات المالية للاطلاع (${counts.moneyOperations})، والمحاولات المرفوضة بقواعد فصل الصلاحيات: ${blocked}`,
    ...(Object.keys(moneyCounts).length ? Object.entries(moneyCounts).map(([a, n]) => `- ${a}: ${n}`) : ['- لا شيء']),
    '',
    'إن رأيت ما لا تعرفه فتواصل مع رديف عبر وسيلتك المسجلة لديها.',
  ].join('\n');
  return { month, period, companies, counts, reportable, subject: `رديف: ملخص صاحب الشركة لشهر ${label}`, body };
}

export interface OwnerDigestRun {
  month: string;
  /** Ready companies that are SINGLE_OPERATOR now. */
  singleOperatorCompanies: string[];
  modeChanged: string[];
  /** QUEUED, ALREADY_QUEUED, NOTHING_TO_REPORT, NO_OWNER_CONTACT, NO_OWNER_EMAIL, DRY_RUN. */
  digest: string;
  /** Whether the outbox can send now (the email provider, G8); the reason when it cannot. */
  delivery: { live: boolean; reason: string | null };
  counts: DigestCounts;
  /** For Radeef's monitoring (JobRun details): the control gap to close. */
  alert: string | null;
}

/** DEC-PO-144: the job fails (monitoring) while a ready company is SINGLE_OPERATOR and no owner contact is registered. */
export class OwnerContactMissingError extends Error {
  readonly details: OwnerDigestRun;
  constructor(details: OwnerDigestRun) {
    super(`OWNER_CONTACT_MISSING: ${details.singleOperatorCompanies.length} ready company(ies) in SINGLE_OPERATOR and no owner contact registered by Radeef (DEC-PO-022 / 144)`);
    this.name = 'OwnerContactMissingError';
    this.details = details;
  }
}

/**
 * The job's work for one tenant: record the mode of every marked company, build the previous month's digest, queue
 * it once to the owner's contact (the email, its audit row and iam.ownerDigest.queued in one transaction).
 */
export async function runOwnerDigest(
  prisma: RootClient,
  opts: { now?: Date; dryRun?: boolean; env?: JobEnv; month?: DigestMonth; companyNames?: CompanyNames } = {},
): Promise<OwnerDigestRun> {
  const now = opts.now ?? new Date();
  const month = opts.month ?? previousMonth(now);
  const cfg = outboxSendConfig(opts.env ?? process.env);
  const delivery = { live: cfg.live, reason: cfg.reason };
  const rec = opts.dryRun ? null : await recordControlsMode(prisma, `job:${OWNER_DIGEST_JOB}`);
  const states = await controlsOfCompanies(prisma, (await readyCompanies(prisma)).map((r) => r.companyId));
  const singleOperatorCompanies = states.filter((s) => s.ready && s.mode === 'SINGLE_OPERATOR').map((s) => s.companyId);
  const digest = await buildOwnerDigest(prisma, month, { companyNames: opts.companyNames });
  const contact = await ownerContactOf(prisma);
  const base = { month: monthLabel(month), singleOperatorCompanies, modeChanged: rec?.changed ?? [], delivery, counts: digest.counts };
  if (!contact && singleOperatorCompanies.length) {
    throw new OwnerContactMissingError({ ...base, digest: 'NO_OWNER_CONTACT', alert: 'OWNER_CONTACT_MISSING' });
  }
  if (!digest.reportable) return { ...base, digest: 'NOTHING_TO_REPORT', alert: null };
  if (!contact) return { ...base, digest: 'NO_OWNER_CONTACT', alert: 'OWNER_CONTACT_MISSING: Radeef must register the owner contact from the formal request (DEC-PO-022)' };
  if (!isOutboxEmailAddress(contact.email)) return { ...base, digest: 'NO_OWNER_EMAIL', alert: 'OWNER_EMAIL_MISSING: the owner contact has no email; SMS waits for G8' };
  if (opts.dryRun) return { ...base, digest: 'DRY_RUN', alert: null };
  const key = ownerDigestKey(month, contact.id);
  const queued = await prisma.$transaction(async (tx) => {
    const added = await enqueueEmails(tx, [{ idempotencyKey: key, recipient: contact.email as string, subject: digest.subject, body: digest.body }]);
    if (!added) return false;
    await audit(tx, {
      actor: { type: 'SYSTEM', id: OWNER_DIGEST_JOB },
      action: OWNER_DIGEST_QUEUED_EVENT,
      entity: { type: 'OwnerDigest', id: monthLabel(month) },
      after: { contactId: contact.id, counts: digest.counts, singleOperatorCompanies, deliveryLive: cfg.live },
      reason: cfg.live ? null : `NOT_SENT_YET: ${cfg.reason}`,
      operationKey: key,
    });
    await emitEvent(tx, {
      type: OWNER_DIGEST_QUEUED_EVENT,
      aggregateType: 'OwnerDigest',
      aggregateId: monthLabel(month),
      idempotencyKey: key,
      payload: { month: monthLabel(month), contactId: contact.id, counts: digest.counts, deliveryLive: cfg.live },
    });
    return true;
  });
  return { ...base, digest: queued ? 'QUEUED' : 'ALREADY_QUEUED', alert: cfg.live ? null : `DIGEST_NOT_SENT: ${cfg.reason} (G8); Radeef relays it with the vendor CLI \`digest\`` };
}

/** owner-digest: daily (the previous month is queued once; the mode is recorded every day). */
export function createOwnerDigestJob(opts: { companyNames?: CompanyNames } = {}): JobDefinition<SystemContext> {
  return {
    name: OWNER_DIGEST_JOB,
    description: "Records the computed controls mode of every marked company, then queues the owner's digest of the previous month to the owner contact Radeef registered (once per month); fails while a ready company is SINGLE_OPERATOR with no owner contact",
    crossCompany: true,
    run: async (ctx) => ({ ...(await runOwnerDigest(ctx.db, { now: ctx.now, dryRun: ctx.dryRun, env: ctx.env, companyNames: opts.companyNames })) }),
  };
}

// ---------------------------------------------------------------------------------------------------
// The owner's view through Radeef (vendor CLI `controls` / `digest`) and the tenant's banner
// ---------------------------------------------------------------------------------------------------

export interface DigestDelivery {
  month: string;
  status: string;
  attempts: number;
  sentAt: string | null;
  createdAt: string;
}

function digestMonthOfKey(key: string): string {
  return key.slice(OWNER_DIGEST_KEY_PREFIX.length, OWNER_DIGEST_KEY_PREFIX.length + 7);
}

/** The recent digests and their delivery state (no body, no recipient). */
export async function recentDigests(db: Db, take = 12): Promise<DigestDelivery[]> {
  const rows = await outboxByPrefix(db, OWNER_DIGEST_KEY_PREFIX, take);
  return rows.map((r) => ({ month: digestMonthOfKey(r.idempotencyKey), status: r.status, attempts: r.attempts, sentAt: r.sentAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() }));
}

/** Delivery states that need the attention of the tenant and Radeef (DEC-PO-022: a failure alerts both). */
export const DIGEST_DELIVERY_PROBLEMS: readonly string[] = Object.freeze(['FAILED', 'UNKNOWN', 'EXPIRED']);

/** A queued digest (the text Radeef relays to the owner before G8), or null. */
export async function queuedDigest(db: Db, month: DigestMonth) {
  const [row] = await outboxByPrefix(db, `${OWNER_DIGEST_KEY_PREFIX}${monthLabel(month)}:`, 1);
  return row ? { month: monthLabel(month), subject: row.subject, body: row.body, status: row.status, recipient: row.recipient, createdAt: row.createdAt.toISOString(), sentAt: row.sentAt?.toISOString() ?? null } : null;
}

export const SINGLE_OPERATOR_BANNER = 'الشركة في وضع المشغّل الواحد: العمليات على مالك تُسجَّل وتُرسل لصاحب الشركة';

/**
 * The control gaps the banner shows to a financial approver (empty for anyone else). `singleCompanyIds`: the
 * viewer's companies that are SINGLE_OPERATOR; `companyIds`: the viewer's companies ('ALL' for every company).
 * No person is named; pending confirmations are counted for the viewer's companies only.
 */
export async function controlsNotice(db: Db, viewer: { role: string; companyIds: 'ALL' | readonly string[]; singleCompanyIds: readonly string[] }): Promise<string[]> {
  if (!isFinancialApproverRole(viewer.role)) return [];
  const notices: string[] = [];
  const [contact, digests, pending] = await Promise.all([ownerContactOf(db), recentDigests(db, 1), pendingOwnerConfirmations(db, 1000)]);
  if (viewer.singleCompanyIds.length && !contact?.email) notices.push('لم تسجّل رديف بريد صاحب الشركة بعد، فلن يصله الملخص الشهري حتى تسجّله بطلبه الرسمي.');
  const last = digests[0];
  if (last && DIGEST_DELIVERY_PROBLEMS.includes(last.status)) notices.push(`تعذّر إرسال ملخص صاحب الشركة لشهر ${last.month}، وأُبلغت رديف.`);
  const mine = pending.filter((p) => (viewer.companyIds === 'ALL' ? true : !!p.companyId && viewer.companyIds.includes(p.companyId)));
  if (mine.length) notices.push(`${mine.length} إجراء بانتظار تأكيد صاحب الشركة عبر رديف.`);
  return notices;
}
