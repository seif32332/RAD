import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError } from '@/lib/http';
import { todayKey } from '@/lib/dates';
import {
  EXIT_REENTRY_VISA_TYPE,
  VISA_MUQEEM_OPERATIONS,
  describeTxError,
  leaveIdFromDeductedFrom,
  pendingVisaSync,
  residentIneligibility,
  suggestReturnBefore,
} from './muqeem/shared';

export const dynamic = 'force-dynamic';

/** Visas are handled by HR and government relations (GOV includes HR_MANAGER). */
const VISA_ROLES = [...new Set([...ROLE_GROUPS.GOV, ...ROLE_GROUPS.HR])];

/** Muqeem transactions returned per visa (newest first). */
const TX_PER_VISA = 10;

/**
 * GET /api/visas -> Visa[] with, for each visa, a `muqeem` block:
 * { eligible, reason, company: {id, name, linked} | null, leave, suggestion, pendingSync, transactions[] }.
 * Never returns the iqama number, credentials or Muqeem request payloads.
 */
export async function GET() {
  try {
    await requireUser(VISA_ROLES);
    const visas = await prisma.visa.findMany({
      include: {
        employee: {
          select: {
            id: true,
            employeeId: true,
            firstNameArabic: true,
            lastNameArabic: true,
            nationality: true,
            iqamaOrIdNumber: true,
            branch: { select: { nameArabic: true } },
            legalCompany: { select: { id: true, nameArabic: true, moiNumber: true, muqeemPlatformId: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const erVisas = visas.filter((v) => v.visaType === EXIT_REENTRY_VISA_TYPE);
    const leaveIds = [...new Set(erVisas.map((v) => leaveIdFromDeductedFrom(v.deductedFrom)).filter((id): id is string => !!id))];
    const [leaves, txs] = await Promise.all([
      leaveIds.length ? prisma.leave.findMany({ where: { id: { in: leaveIds } }, select: { id: true, startDate: true, endDate: true } }) : [],
      erVisas.length
        ? prisma.muqeemTransaction.findMany({
            where: { entityType: 'VISA', entityId: { in: erVisas.map((v) => v.id) }, operation: { in: [...VISA_MUQEEM_OPERATIONS] } },
            select: { id: true, entityId: true, operation: true, status: true, externalRef: true, errorMessage: true, documentUrl: true, createdAt: true, completedAt: true, requestSummary: true },
            orderBy: { createdAt: 'desc' },
          })
        : [],
    ]);
    const leaveById = new Map(leaves.map((l) => [l.id, l]));
    const txByVisa = new Map<string, typeof txs>();
    for (const t of txs) {
      if (!t.entityId) continue;
      const list = txByVisa.get(t.entityId) ?? [];
      list.push(t);
      txByVisa.set(t.entityId, list);
    }
    const today = todayKey();

    const out = visas.map((v) => {
      const { iqamaOrIdNumber, legalCompany, ...employee } = v.employee;
      let muqeem = null;
      if (v.visaType === EXIT_REENTRY_VISA_TYPE) {
        const linked = !!legalCompany?.moiNumber?.trim() && !!legalCompany?.muqeemPlatformId;
        let reason = residentIneligibility({ nationality: employee.nationality, iqamaOrIdNumber });
        if (!reason && !legalCompany) reason = 'لم تُحدَّد الشركة الكفيلة (الكيان القانوني) للموظف في ملفه، وهي التي يُستخدم حسابها في مقيم.';
        if (!reason && !linked) reason = `الشركة الكفيلة «${legalCompany?.nameArabic}» غير مربوطة بمنصة مقيم (رقم المنشأة 700 وحساب مقيم في صفحة الشركة).`;
        const leaveId = leaveIdFromDeductedFrom(v.deductedFrom);
        const leave = leaveId ? leaveById.get(leaveId) : undefined;
        muqeem = {
          eligible: !reason,
          reason,
          company: legalCompany ? { id: legalCompany.id, name: legalCompany.nameArabic, linked } : null,
          leave: leave ? { id: leave.id, startDate: leave.startDate, endDate: leave.endDate } : null,
          suggestion: v.status === 'PAID' ? suggestReturnBefore({ leaveEnd: leave?.endDate ?? null, ticketReturn: v.returnDate, today }) : null,
          /** SUCCEEDED operation not yet reflected on the visa (e.g. reconciled elsewhere): action 'SYNC'. */
          pendingSync: pendingVisaSync(v, txByVisa.get(v.id) ?? []),
          transactions: (txByVisa.get(v.id) ?? []).slice(0, TX_PER_VISA).map((t) => ({
            id: t.id,
            operation: t.operation,
            status: t.status,
            externalRef: t.externalRef,
            error: describeTxError(t.errorMessage),
            documentUrl: t.documentUrl,
            createdAt: t.createdAt,
            completedAt: t.completedAt,
          })),
        };
      }
      return { ...v, employee, muqeem };
    });
    return NextResponse.json(out);
  } catch (err) {
    return handleApiError(err, 'visas:GET');
  }
}
