// Document notifications through NotificationOutbox (sent by `scripts/jobs.mjs outbox-dispatch`).
//
// Same rules as the expiry digest: one row per event and recipient (idempotencyKey), and the body
// carries no personal data (no names, ID numbers, amounts): the document number, what happened and
// a login link. The details stay behind the login.
import 'server-only';
import type { Prisma } from '@prisma/client';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type DocumentNotice =
  | { kind: 'ISSUED'; number: string; typeLabel: string; acknowledge?: boolean; consentBy?: string }
  | { kind: 'REJECTED'; typeLabel: string }
  | { kind: 'REVOKED'; number: string; typeLabel: string }
  | { kind: 'DISPUTED'; number: string; typeLabel: string }
  | { kind: 'OFFER_ANSWERED'; number: string; typeLabel: string; accepted: boolean }
  | { kind: 'CONSENT_ANSWERED'; number: string; typeLabel: string; accepted: boolean }
  | { kind: 'APPROVAL_REQUESTED'; typeLabel: string }
  | { kind: 'AUTHORIZATION_PENDING'; typeLabel: string }
  | { kind: 'ASSET_CHANGED'; assetLabel: string };

function appLink(path: string): string {
  const base = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s"'<>]+$/.test(base) ? `${base}${path}` : '';
}

/** Subject + body of a notice (exported for tests: no personal data may appear). */
export function noticeText(n: DocumentNotice): { subject: string; body: string } {
  const portal = appLink('/portal');
  const documents = appLink('/documents');
  const settings = appLink('/documents/settings');
  const tail = (link: string) => (link ? `\n\n${link}` : '');
  switch (n.kind) {
    case 'ISSUED':
      if (n.consentBy) {
        return { subject: `رديف: ${n.typeLabel} بانتظار موافقتك`, body: `صدر لك ${n.typeLabel} برقم ${n.number}. سجّل الدخول إلى بوابة الموظف للاطلاع عليه والموافقة عليه أو رفضه قبل ${n.consentBy}.${tail(portal)}` };
      }
      if (n.acknowledge) {
        return { subject: `رديف: صدر لك ${n.typeLabel}`, body: `صدر لك ${n.typeLabel} برقم ${n.number}. سجّل الدخول إلى بوابة الموظف للاطلاع عليه والإقرار باستلامه.${tail(portal)}` };
      }
      return { subject: `رديف: صدر ${n.typeLabel}`, body: `صدر ${n.typeLabel} برقم ${n.number}. سجّل الدخول إلى بوابة الموظف لتنزيله.${tail(portal)}` };
    case 'REJECTED':
      return { subject: `رديف: رُفض طلب ${n.typeLabel}`, body: `رُفض طلبك (${n.typeLabel}). سبب الرفض في بوابة الموظف.${tail(portal)}` };
    case 'REVOKED':
      return { subject: `رديف: أُلغي المستند ${n.number}`, body: `أُلغي ${n.typeLabel} رقم ${n.number}، وتعرض صفحة التحقق الآن أنه ملغى.${tail(portal)}` };
    case 'OFFER_ANSWERED':
      return {
        subject: `رديف: ${n.accepted ? 'قبول' : 'اعتذار عن'} ${n.typeLabel} ${n.number}`,
        body: `${n.accepted ? 'قبِل المرشح' : 'اعتذر المرشح عن'} ${n.typeLabel} رقم ${n.number}. التفاصيل في صفحة المستندات الرسمية.${tail(documents)}`,
      };
    case 'CONSENT_ANSWERED':
      return {
        subject: `رديف: ${n.accepted ? 'موافقة الموظف على' : 'رفض الموظف'} ${n.typeLabel} ${n.number}`,
        body: `${n.accepted ? 'وافق الموظف على' : 'رفض الموظف'} ${n.typeLabel} رقم ${n.number}.${n.accepted ? ' يُطبَّق التغيير على ملفه في تاريخ السريان.' : ' لا يتغير شيء في ملفه.'} التفاصيل في صفحة المستندات الرسمية.${tail(documents)}`,
      };
    case 'DISPUTED':
      return { subject: `رديف: اعتراض على ${n.typeLabel} ${n.number}`, body: `اعترض الموظف على ${n.typeLabel} رقم ${n.number}. سبب الاعتراض في صفحة المستندات الرسمية.${tail(documents)}` };
    case 'APPROVAL_REQUESTED':
      return { subject: `رديف: ${n.typeLabel} بانتظار اعتمادك`, body: `يوجد طلب ${n.typeLabel} بانتظار الاعتماد.${tail(documents)}` };
    case 'AUTHORIZATION_PENDING':
      return { subject: 'رديف: تفويض توقيع بانتظار قبولك', body: `مُنحت تفويضاً مسبقاً بطباعة توقيعك على ${n.typeLabel}. لا يسري حتى تقبله من صفحة المستندات الرسمية، ويمكن رفضه بتجاهله.${tail(documents)}` };
    case 'ASSET_CHANGED':
      return { subject: `رديف: تغيّرت ${n.assetLabel} في إعدادات المستندات`, body: `رُفعت ${n.assetLabel} جديدة في إعدادات المستندات الرسمية لشركتك. إن لم تكن تتوقع ذلك فراجع المالك فوراً.${tail(settings)}` };
  }
}

/**
 * Queues one email per active user with a valid address. `key` makes it idempotent
 * (retrying the same step never sends twice).
 */
export async function enqueueNotice(tx: Prisma.TransactionClient, userIds: ReadonlyArray<string | null | undefined>, key: string, notice: DocumentNotice): Promise<number> {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (!ids.length) return 0;
  const users = await tx.user.findMany({ where: { id: { in: ids }, isActive: true }, select: { id: true, email: true } });
  const { subject, body } = noticeText(notice);
  const data = users
    .filter((u) => EMAIL_RE.test(u.email))
    .map((u) => ({ idempotencyKey: `doc:${key}:${u.id}`, channel: 'EMAIL', recipient: u.email, subject, body }));
  if (!data.length) return 0;
  const res = await tx.notificationOutbox.createMany({ data, skipDuplicates: true });
  return res.count;
}

/** The login account of an employee, if any. */
export async function employeeUserId(tx: Prisma.TransactionClient, employeeId: string): Promise<string | null> {
  const e = await tx.employee.findUnique({ where: { id: employeeId }, select: { userId: true } });
  return e?.userId ?? null;
}
