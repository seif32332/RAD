// /api/workforce/localization-decisions — «سجل قرارات التوطين» (LocalizationDecision).
// GET: every row (the history) parsed (occupations, phases), with `current` = the newest row of its group
//      (the one the engine uses). WORKFORCE roles.
// POST (SUPER_ADMIN): adds a NEW row. History is immutable (no PUT / PATCH / DELETE): a correction is a
//      new row of the same group with a note (and optionally `correctsId`); it supersedes the older row
//      for the calculations. Audited.
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, notFound, parseBody } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { DECISION_STATUS_LABELS, parseDecision } from '@/lib/workforce/saudization';
import { loadLocalizationDecisions } from '@/lib/workforce/load';
import { ESTIMATE_DISCLAIMER } from '@/lib/workforce/version';
import { newDecisionSchema } from '../_lib/saudization-schemas';
import { currentDecisions } from '../_lib/saudization';
import { limitOrThrow } from '../_lib/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    const rows = await loadLocalizationDecisions();
    const current = new Set(currentDecisions(rows).map((r) => r.id));
    return NextResponse.json({
      disclaimer: ESTIMATE_DISCLAIMER,
      canAdd: user.role === 'SUPER_ADMIN',
      statusLabels: DECISION_STATUS_LABELS,
      decisions: rows.map((r) => ({ ...parseDecision(r), current: current.has(r.id), createdAt: r.createdAt.toISOString() })),
    });
  } catch (err) {
    return handleApiError(err, 'workforce:localization-decisions:GET');
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(['SUPER_ADMIN']);
    const b = await parseBody(req, newDecisionSchema);
    limitOrThrow(user, 'loc-post', 60, 60 * 60_000);
    let notes = b.notes ?? null;
    if (b.correctsId) {
      const old = await prisma.localizationDecision.findUnique({ where: { id: b.correctsId }, select: { id: true, groupNameAr: true } });
      if (!old) throw notFound('السجل المراد تصحيحه غير موجود');
      notes = `تصحيح للسجل ${old.id} (${old.groupNameAr}): ${notes ?? ''}`.trim();
    }
    const occupations = b.occupations.map((o) =>
      typeof o === 'string' ? { code: /^\d+$/.test(o) ? o : null, nameAr: /^\d+$/.test(o) ? null : o, nameEn: null } : { code: o.code ?? null, nameAr: o.nameAr ?? null, nameEn: o.nameEn ?? null },
    );
    const created = await prisma.localizationDecision.create({
      data: {
        groupNameAr: b.groupNameAr,
        occupationsJson: JSON.stringify(occupations),
        phasesJson: JSON.stringify([...b.phases].sort((x, y) => x.effectiveFrom.localeCompare(y.effectiveFrom))),
        minEstablishmentSize: b.minEstablishmentSize ?? null,
        minWage: b.minWage ?? null,
        scope: b.scope ?? null,
        decisionNo: b.decisionNo ?? null,
        decisionDate: b.decisionDate ?? null,
        status: b.status,
        sourceUrl: b.sourceUrl ?? null,
        page: b.page ?? null,
        notes,
        createdById: user.id,
      },
      select: { id: true },
    });
    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'LocalizationDecision',
      entityId: created.id,
      details: { groupNameAr: b.groupNameAr, occupations: occupations.length, phases: b.phases, minWage: b.minWage ?? null, status: b.status, correctsId: b.correctsId ?? null, sourceUrl: b.sourceUrl ?? null },
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'workforce:localization-decisions:POST');
  }
}
