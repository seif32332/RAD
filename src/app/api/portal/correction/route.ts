import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, conflict, forbidden, handleApiError, parseBody } from '@/lib/http';
import { zDate, zId, zOptText, zText } from '@/lib/validation';
import { dateKey } from '@/lib/dates';
import { logAudit } from '@/lib/audit';
import { CORRECTION_STATUS, CORRECTION_TYPES, DATA_UPDATE_PREFIX, DATA_UPDATE_TAGS, isHrDirectRequest } from '@/lib/hr-workflows';
import { resolveSelfContext } from '@/lib/employee-scope';
import { authz, resolveActor, scopedPrisma } from '@/modules/iam';
import { maskedIban, requestFinancialChange, runCompensationTransaction, type FinancialChangeView } from '@/modules/compensation';
import { normalizeIban } from '@/lib/iban';

/** The value of a tagged line ("الآيبان: SA…") of a data-update request, or null. */
function taggedLine(reason: string, tag: string): { index: number; value: string } | null {
  const lines = reason.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith(tag)) continue;
    const rest = t.slice(tag.length).trimStart();
    if (!rest.startsWith(':')) continue;
    const value = rest.slice(1).trim();
    if (value && value !== '-') return { index: i, value };
  }
  return null;
}

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  /** Legacy: the page still sends it; it must match the session employee. */
  employeeId: zId.optional(),
  date: zDate,
  reason: zText(4000),
  attachmentUrl: zOptText(2000),
  /** Fingerprint corrections: LATE | EARLY_LEAVE | ABSENT | GENERAL (default GENERAL). Ignored for general requests. */
  correctionType: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(CORRECTION_TYPES).optional()),
  /** Rejected / flagged self punch the request is about (its server time is used on approval). */
  punchId: zId.optional(),
});

/**
 * POST /api/portal/correction — self-service fingerprint correction / general request
 * (general requests are encoded as "[طلب: ...]" in the reason and go straight to HR, so their
 * type is always GENERAL). Always filed for the logged-in employee.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    // P1-SCOPE: SelfContext. Every read and the write go through the scoped client, so a punch of another
    // employee is "not found" and the request can only be filed for the session employee.
    const self = await resolveSelfContext(prisma, await resolveActor(prisma, user));
    authz.assert(self, 'portal.self.request');
    const employeeId = self.employeeId;
    const db = scopedPrisma(self);
    const body = await parseBody(req, createSchema);
    if (body.employeeId && body.employeeId !== employeeId) throw forbidden('لا يمكنك تقديم طلب لموظف آخر');

    const hrDirect = isHrDirectRequest(body.reason);
    const linkedToPunch = !!body.punchId && !hrDirect;

    // Prevent duplicate pending requests with the same reason. A request linked to a punch is
    // checked per punch below instead: the pre-filled reason is the same for every rejection of
    // the same kind (e.g. the face service was down two days in a row).
    if (!linkedToPunch) {
      const existing = await db.attendanceCorrection.findFirst({
        where: { employeeId, reason: body.reason, status: CORRECTION_STATUS.PENDING },
        select: { id: true },
      });
      if (existing) throw conflict('يوجد لديك طلب مطابق قيد الانتظار حالياً.');
    }
    const correctionType = hrDirect ? 'GENERAL' : (body.correctionType ?? 'GENERAL');

    let punchId: string | null = null;
    if (body.punchId && linkedToPunch) {
      const punch = await db.attendancePunch.findFirst({ where: { id: body.punchId }, select: { employeeId: true, result: true, workDate: true } });
      if (!punch || punch.employeeId !== employeeId) throw forbidden('الحركة المرتبطة بالطلب غير موجودة');
      if (punch.result === 'ACCEPTED') throw badRequest('هذه الحركة مقبولة ولا تحتاج إلى تصحيح');
      if (dateKey(punch.workDate) !== dateKey(body.date)) throw badRequest('تاريخ الطلب لا يطابق تاريخ الحركة');
      const pendingForPunch = await db.attendanceCorrection.findFirst({
        where: { punchId: body.punchId, status: CORRECTION_STATUS.PENDING },
        select: { id: true },
      });
      if (pendingForPunch) throw conflict('يوجد طلب تصحيح قيد الانتظار لهذه الحركة.');
      punchId = body.punchId;
    }

    // P1-PAY-B (BR-PAY-009, AUTO-PAY-004): an IBAN in a data-update request is the employee's own financial
    // change request (requested by him, decided by a second person). The request text keeps the IBAN
    // masked only, with the reference of the change.
    const ibanLine = body.reason.trimStart().startsWith(DATA_UPDATE_PREFIX) ? taggedLine(body.reason, DATA_UPDATE_TAGS.IBAN) : null;
    let financialChange: FinancialChangeView | null = null;
    const request = await runCompensationTransaction(db, async (tx) => {
      let reason = body.reason;
      if (ibanLine) {
        const iban = normalizeIban(ibanLine.value);
        const bankName = taggedLine(body.reason, DATA_UPDATE_TAGS.BANK)?.value ?? null;
        const current = await tx.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { salaryPaymentMethod: true } });
        const filed = await requestFinancialChange(tx, {
          actor: { id: user.id, role: user.role, employeeId },
          employeeId,
          source: 'PORTAL',
          bank: { iban, bankName, paymentMethod: current.salaryPaymentMethod === 'WPS' ? 'WPS' : 'BANK_TRANSFER' },
          note: 'طلب تحديث بيانات من البوابة الذاتية',
          operationKey: `portal.iban:${employeeId}:${req.headers.get('idempotency-key')?.trim().slice(0, 100) || Date.now()}`,
          ipAddress: getClientIp(req),
        });
        financialChange = filed.changes[0] ?? null;
        const lines = body.reason.split(/\r?\n/);
        lines[ibanLine.index] = `${DATA_UPDATE_TAGS.IBAN}: ${maskedIban(iban.slice(-4))}${financialChange ? ` (طلب تغيير مالي ${financialChange.id})` : ''}`;
        reason = lines.join('\n');
      }
      return tx.attendanceCorrection.create({
        data: {
          employeeId,
          date: body.date,
          reason,
          attachmentUrl: body.attachmentUrl ?? null,
          correctionType,
          status: CORRECTION_STATUS.PENDING,
          punchId,
        },
      });
    });

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'AttendanceCorrection',
      entityId: request.id,
      details: { employeeId, date: body.date, correctionType, selfService: true, punchId },
      ipAddress: getClientIp(req),
    });

    const message = hrDirect ? 'تم رفع الطلب إلى الموارد البشرية' : 'تم رفع طلب تصحيح البصمة';
    return NextResponse.json({ message, request, financialChange }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'portal/correction:POST');
  }
}
