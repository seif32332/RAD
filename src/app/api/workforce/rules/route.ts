// /api/workforce/rules — «سجل القواعد والأدلة».
// GET: every RuleParameter version grouped by domain and key (CURRENT / FUTURE / SUPERSEDED), plus the
//      GosiRate table presented as rules of the GOSI domain. WORKFORCE roles.
// POST: adds a NEW version of a rule (SUPER_ADMIN only). History is never edited: there is no PUT /
//       PATCH / DELETE, and a version with the same (key, effectiveFrom) is refused (409). Audited.
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, conflict, handleApiError, parseBody } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { todayKey } from '@/lib/dates';
import { ESTIMATE_DISCLAIMER } from '@/lib/workforce/version';
import { newRuleVersionSchema } from '../_lib/schemas';
import { buildRulesView } from '../_lib/views';
import { limitOrThrow } from '../_lib/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    const [rules, gosiRates] = await Promise.all([
      prisma.ruleParameter.findMany({
        select: { key: true, domain: true, label: true, value: true, valueJson: true, unit: true, effectiveFrom: true, effectiveTo: true, status: true, sourceUrl: true, sourceQuote: true, notes: true, createdAt: true },
        orderBy: [{ domain: 'asc' }, { key: 'asc' }, { effectiveFrom: 'asc' }],
      }),
      prisma.gosiRate.findMany({
        select: { regime: true, isSaudi: true, effectiveFrom: true, employeeRate: true, employerRate: true, minWage: true, maxWage: true, isProvisional: true, source: true, createdAt: true },
        orderBy: [{ regime: 'asc' }, { isSaudi: 'asc' }, { effectiveFrom: 'asc' }],
      }),
    ]);
    const domains = buildRulesView(rules, gosiRates, todayKey());
    return NextResponse.json({ today: todayKey(), disclaimer: ESTIMATE_DISCLAIMER, canAddVersion: user.role === 'SUPER_ADMIN', domains });
  } catch (err) {
    return handleApiError(err, 'workforce:rules:GET');
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(['SUPER_ADMIN']);
    const b = await parseBody(req, newRuleVersionSchema);
    limitOrThrow(user, 'rules-post', 30, 60 * 60_000);

    const latest = await prisma.ruleParameter.findFirst({ where: { key: b.key }, orderBy: { effectiveFrom: 'desc' }, select: { domain: true, label: true, unit: true } });
    const domain = b.domain ?? latest?.domain;
    const label = b.label ?? latest?.label;
    if (!domain || !label) throw badRequest('مفتاح جديد: المجال والاسم العربي مطلوبان');
    if (latest && b.domain && b.domain !== latest.domain) throw badRequest(`المفتاح ${b.key} مسجّل في مجال ${latest.domain}؛ لا يُنقل مفتاح بين المجالات`);
    const exists = await prisma.ruleParameter.findUnique({ where: { key_effectiveFrom: { key: b.key, effectiveFrom: b.effectiveFrom } }, select: { id: true } });
    if (exists) throw conflict('يوجد إصدار لهذا المفتاح بنفس تاريخ السريان. لا يُعدَّل التاريخ: أضف إصداراً بتاريخ سريان جديد.');

    const created = await prisma.ruleParameter.create({
      data: {
        key: b.key,
        domain,
        label,
        value: b.value ?? null,
        valueJson: b.valueJson ?? null,
        unit: b.unit ?? latest?.unit ?? null,
        effectiveFrom: b.effectiveFrom,
        status: b.status,
        sourceUrl: b.sourceUrl ?? null,
        sourceQuote: b.sourceQuote ?? null,
        notes: b.notes ?? null,
        verifiedAt: b.status === 'VERIFIED_PRIMARY' || b.status === 'CORROBORATED_SECONDARY' ? new Date() : null,
        verifiedBy: b.status === 'VERIFIED_PRIMARY' || b.status === 'CORROBORATED_SECONDARY' ? user.name : null,
        createdById: user.id,
      },
      select: { id: true, key: true, effectiveFrom: true },
    });
    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'RuleParameter',
      entityId: created.id,
      details: { key: b.key, domain, label, value: b.value ?? null, valueJson: b.valueJson ?? null, unit: b.unit ?? null, effectiveFrom: b.effectiveFrom.toISOString().slice(0, 10), status: b.status, sourceUrl: b.sourceUrl ?? null, newKey: !latest },
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ id: created.id, key: created.key, effectiveFrom: created.effectiveFrom.toISOString().slice(0, 10) }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'workforce:rules:POST');
  }
}
