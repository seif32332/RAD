// /api/workforce/nitaqat — «سجل نطاقات» (NitaqatActivity + NitaqatCurve).
// GET: every activity with its curve constants per year and status (AMBIGUOUS rows are marked «يحتاج
//      مطابقة مع ملحق الدليل»), and how many companies use it. ?lite=1: key / name / code / status only
//      (the company form select). WORKFORCE roles.
// POST (SUPER_ADMIN): adds ONE new row — {type: 'ACTIVITY', ...} or {type: 'CURVE', ...} — with its source.
//      History is immutable: no PUT / PATCH / DELETE; an existing activity key or (activity, band, year)
//      is refused (409). A correction is a new activity (new key, e.g. "…-v2") with a note; companies then
//      select it. Audited.
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { conflict, handleApiError, notFound, parseBody } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { AMBIGUOUS_LABEL, CURVE_BANDS, nitaqatActivityKey } from '@/lib/workforce/nitaqat';
import { loadNitaqatRegister } from '@/lib/workforce/load';
import { ESTIMATE_DISCLAIMER } from '@/lib/workforce/version';
import { nitaqatPostSchema } from '../_lib/saudization-schemas';
import { limitOrThrow } from '../_lib/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    const lite = new URL(req.url).searchParams.get('lite') === '1';
    const { activities, curves } = await loadNitaqatRegister();
    if (lite) return NextResponse.json({ activities: activities.map((a) => ({ key: a.key, nameAr: a.nameAr, code: a.code ?? null, sizeSegment: a.sizeSegment ?? null, status: a.status })) });
    const usage = await prisma.company.groupBy({ by: ['nitaqatActivityKey'], where: { nitaqatActivityKey: { not: null } }, _count: { _all: true } });
    const used = new Map(usage.map((u) => [u.nitaqatActivityKey as string, u._count._all]));
    const years = [...new Set(curves.map((c) => c.year))].sort((a, b) => a - b);
    return NextResponse.json({
      disclaimer: ESTIMATE_DISCLAIMER,
      canAdd: user.role === 'SUPER_ADMIN',
      ambiguousLabel: AMBIGUOUS_LABEL,
      bands: CURVE_BANDS,
      years,
      activities: activities.map((a) => ({
        ...a,
        companies: used.get(a.key) ?? 0,
        curves: curves
          .filter((c) => c.activityKey === a.key)
          .map((c) => ({ id: c.id, band: c.band, year: c.year, m: c.m, c: c.c, status: c.status, page: c.page ?? null, sourceUrl: c.sourceUrl ?? null, note: c.note ?? null, createdAt: c.createdAt.toISOString() })),
      })),
    });
  } catch (err) {
    return handleApiError(err, 'workforce:nitaqat:GET');
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(['SUPER_ADMIN']);
    const b = await parseBody(req, nitaqatPostSchema);
    limitOrThrow(user, 'nitaqat-post', 60, 60 * 60_000);
    if (b.type === 'ACTIVITY') {
      const key = b.key ?? nitaqatActivityKey(b.nameAr, b.sizeSegment);
      if (!key) throw conflict('تعذر إنشاء مفتاح للنشاط من اسمه');
      const exists = await prisma.nitaqatActivity.findUnique({ where: { key }, select: { key: true } });
      if (exists) throw conflict(`يوجد نشاط بالمفتاح «${key}». السجل لا يُعدَّل: لتصحيحه أضف نشاطاً بمفتاح جديد (مثل ${key}-v2) مع ملاحظة، ثم اختره في إعدادات الشركة.`);
      const created = await prisma.nitaqatActivity.create({
        data: { key, nameAr: b.nameAr, code: b.code ?? null, sizeSegment: b.sizeSegment ?? null, status: b.status, sourceUrl: b.sourceUrl ?? null, page: b.page ?? null, notes: b.notes ?? null },
        select: { key: true },
      });
      await logAudit({ userId: user.id, action: 'CREATE', entityType: 'NitaqatActivity', entityId: created.key, details: { key, nameAr: b.nameAr, code: b.code ?? null, status: b.status, sourceUrl: b.sourceUrl ?? null, page: b.page ?? null }, ipAddress: getClientIp(req) });
      return NextResponse.json({ type: 'ACTIVITY', key: created.key }, { status: 201 });
    }
    const activity = await prisma.nitaqatActivity.findUnique({ where: { key: b.activityKey }, select: { key: true } });
    if (!activity) throw notFound('النشاط غير موجود في السجل');
    const exists = await prisma.nitaqatCurve.findUnique({ where: { activityKey_band_year: { activityKey: b.activityKey, band: b.band, year: b.year } }, select: { id: true } });
    if (exists) throw conflict('توجد ثوابت لهذا النشاط والنطاق والسنة. السجل لا يُعدَّل: لتصحيحها أضف نشاطاً بمفتاح جديد بثوابته المصححة مع ملاحظة.');
    const created = await prisma.nitaqatCurve.create({
      data: { activityKey: b.activityKey, band: b.band, year: b.year, m: b.m, c: b.c, status: b.status, sourceUrl: b.sourceUrl ?? null, page: b.page ?? null, note: b.note ?? null, createdById: user.id },
      select: { id: true },
    });
    await logAudit({ userId: user.id, action: 'CREATE', entityType: 'NitaqatCurve', entityId: created.id, details: { activityKey: b.activityKey, band: b.band, year: b.year, m: b.m, c: b.c, status: b.status, sourceUrl: b.sourceUrl ?? null, page: b.page ?? null }, ipAddress: getClientIp(req) });
    return NextResponse.json({ type: 'CURVE', id: created.id }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'workforce:nitaqat:POST');
  }
}
