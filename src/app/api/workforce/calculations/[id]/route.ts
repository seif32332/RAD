// GET /api/workforce/calculations/[id] — one saved calculation: inputs, outputs, engine version and the
// exact rule versions it used (JSON parsed). Snapshots are immutable: no PUT / PATCH / DELETE.
// Viewers outside the HR group get inputs / outputs through redactSnapshotJson (src/lib/workforce/privacy.ts).
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, notFound } from '@/lib/http';
import { zId } from '@/lib/validation';
import { canSeeDisability, redactSnapshotJson } from '@/lib/workforce/privacy';

export const dynamic = 'force-dynamic';

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    // Disability / identity data: redacted at READ time for viewers outside the HR group, so snapshots
    // saved before the inputs were stripped (and the HRDF category codes in outputs) are safe too.
    const view = canSeeDisability(user.role) ? (v: unknown) => v : redactSnapshotJson;
    const idParse = zId.safeParse((await ctx.params).id);
    if (!idParse.success) throw notFound('الحساب المحفوظ غير موجود');
    const row = await prisma.workforceCalculation.findUnique({ where: { id: idParse.data } });
    if (!row) throw notFound('الحساب المحفوظ غير موجود');
    const creator = row.createdById ? await prisma.user.findUnique({ where: { id: row.createdById }, select: { name: true, email: true } }) : null;
    return NextResponse.json({
      id: row.id,
      kind: row.kind,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      title: row.title,
      engineVersion: row.engineVersion,
      createdAt: row.createdAt.toISOString(),
      createdByName: creator ? creator.name || creator.email : null,
      ruleVersions: parse(row.ruleVersions),
      inputs: view(parse(row.inputs)),
      outputs: view(parse(row.outputs)),
    });
  } catch (err) {
    return handleApiError(err, 'workforce:calculations:[id]:GET');
  }
}
