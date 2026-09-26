import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { prisma } from '@/lib/prisma';
import { HttpError, badRequest, handleApiError, parseBody } from '@/lib/http';
import { zId } from '@/lib/validation';
import { rateLimit } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit';
import { isSaudiNationalityValue } from '@/lib/employee-shared';
import { toApiError, type NormalizedResident } from '@/lib/muqeem';
import { normalizeIqamaNumber, planEmployeeUpdate, SYNC_FIELDS, SYNC_FIELD_LABELS, type FieldChange } from '@/lib/muqeem-sync';
import { EMPLOYEE_SELECT, fetchAllResidents, loadCompany, toSyncEmployee } from '../_shared';

export const dynamic = 'force-dynamic';

const MAX_UPDATES = 200;

const BodySchema = z.object({
  companyId: zId,
  updates: z
    .array(
      z.object({
        employeeId: zId,
        fields: z.array(z.enum(SYNC_FIELDS)).min(1, 'اختر حقلاً واحداً على الأقل').max(SYNC_FIELDS.length),
      }),
    )
    .min(1, 'لم يتم اختيار أي موظف')
    .max(MAX_UPDATES, `الحد الأقصى ${MAX_UPDATES} موظف في المرة الواحدة`),
});

type SkipReason = 'NOT_IN_MUQEEM' | 'NO_CHANGE' | 'CHANGED_MEANWHILE';

const SKIP_MESSAGES: Record<SkipReason, string> = {
  NOT_IN_MUQEEM: 'لم يعد ضمن تقرير المقيمين النشطين في مقيم، لم يُعدَّل شيء',
  NO_CHANGE: 'البيانات مطابقة لمقيم بالفعل، لم يُعدَّل شيء',
  CHANGED_MEANWHILE: 'عُدِّلت بيانات الموظف أثناء التطبيق، أعد المطابقة ثم حاول مجدداً',
};

/**
 * POST /api/integrations/muqeem/residents/apply  (ROLE_GROUPS.GOV: HR manager + government relations + admins)
 * { companyId, updates: [{ employeeId, fields: ('iqamaOrIdExp'|'passportNumber'|'passportExp'|'occupationName'|'dependentsCount')[] }] }
 *
 * Copies the selected fields FROM MUQEEM to the employees. Values sent by the client are never used:
 * the active residents report is read again (read-only on Muqeem) and only the selected fields that
 * still differ are written, in one database transaction, audited per employee with before/after.
 * Nothing is sent to Muqeem except the report read. Saudi / terminated / other-company employees are refused.
 * 200 { applied: [{ employeeId, employeeName, changes }], skipped: [{ employeeId, employeeName, reason, message }] }
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.GOV);
    const limit = rateLimit(`muqeem-sync-apply:${user.id}`, 40, 10 * 60_000);
    if (!limit.ok) throw new HttpError(429, 'تم تجاوز عدد مرات التطبيق المسموح بها، حاول بعد بضع دقائق');
    const { companyId, updates } = await parseBody(req, BodySchema);
    await loadCompany(companyId);

    const ids = updates.map((u) => u.employeeId);
    if (new Set(ids).size !== ids.length) throw badRequest('تكرر نفس الموظف في الطلب');

    // 1. Eligibility (before any call to Muqeem).
    const employees = await prisma.employee.findMany({ where: { id: { in: ids } }, select: EMPLOYEE_SELECT });
    const byId = new Map(employees.map((e) => [e.id, e]));
    const problems: string[] = [];
    for (const id of ids) {
      const e = byId.get(id);
      const name = e ? `${e.firstNameArabic} ${e.lastNameArabic}`.trim() : id;
      if (!e) problems.push(`موظف غير موجود (${id})`);
      else if (e.legalCompanyId !== companyId) problems.push(`${name}: ليس على كفالة هذه الشركة`);
      else if (e.isTerminated) problems.push(`${name}: منتهية خدمته`);
      else if (isSaudiNationalityValue(e.nationality)) problems.push(`${name}: سعودي الجنسية، ليس مقيماً في مقيم`);
    }
    if (problems.length) throw badRequest(`لا يمكن التطبيق على بعض الموظفين: ${problems.slice(0, 5).join('؛ ')}`, { problems });

    // 2. Fresh values from Muqeem (read-only).
    const report = await fetchAllResidents(companyId);
    const residents = new Map<string, NormalizedResident>();
    for (const r of report.rows) {
      const k = normalizeIqamaNumber(r.iqamaNumber);
      if (k && !residents.has(k)) residents.set(k, r);
    }

    // 3. Apply in one transaction, re-reading each employee inside it.
    const ip = getClientIp(req);
    const result = await prisma.$transaction(
      async (tx) => {
        const applied: { employeeId: string; employeeName: string; changes: (FieldChange & { label: string })[] }[] = [];
        const skipped: { employeeId: string; employeeName: string; reason: SkipReason; message: string }[] = [];
        for (const u of updates) {
          const row = await tx.employee.findUnique({ where: { id: u.employeeId }, select: { ...EMPLOYEE_SELECT, updatedAt: true } });
          if (!row) continue; // checked above; deleted meanwhile
          const e = toSyncEmployee(row);
          const skip = (reason: SkipReason) => skipped.push({ employeeId: e.id, employeeName: e.nameArabic, reason, message: SKIP_MESSAGES[reason] });
          const resident = residents.get(normalizeIqamaNumber(e.iqamaOrIdNumber) ?? '');
          if (!resident) {
            skip('NOT_IN_MUQEEM');
            continue;
          }
          const plan = planEmployeeUpdate(e, resident, u.fields);
          if (!plan.changes.length) {
            skip('NO_CHANGE');
            continue;
          }
          const updated = await tx.employee.updateMany({ where: { id: e.id, updatedAt: row.updatedAt }, data: plan.data });
          if (updated.count !== 1) {
            skip('CHANGED_MEANWHILE');
            continue;
          }
          await logAudit(
            {
              userId: user.id,
              action: 'UPDATE',
              entityType: 'Employee',
              entityId: e.id,
              details: {
                source: 'MUQEEM_RESIDENTS_SYNC',
                companyId,
                iqamaLast4: (normalizeIqamaNumber(e.iqamaOrIdNumber) ?? '').slice(-4),
                before: Object.fromEntries(plan.changes.map((c) => [c.field, c.before])),
                after: Object.fromEntries(plan.changes.map((c) => [c.field, c.after])),
                unchanged: plan.unchanged,
              },
              ipAddress: ip,
            },
            tx,
          );
          applied.push({ employeeId: e.id, employeeName: e.nameArabic, changes: plan.changes.map((c) => ({ ...c, label: SYNC_FIELD_LABELS[c.field] })) });
        }
        return { applied, skipped };
      },
      { timeout: 30_000 },
    );

    return NextResponse.json({
      ...result,
      counts: { requested: updates.length, applied: result.applied.length, skipped: result.skipped.length },
      truncated: report.truncated,
    });
  } catch (err) {
    return handleApiError(toApiError(err), 'integrations/muqeem/residents/apply:POST');
  }
}
