// Archive of processed requests (latest 50 of each kind) for the incoming-requests hub.
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hasRole, requireUser } from '@/lib/auth';
import { LEAVE_STATUS, LOAN_STATUS, ROLE_GROUPS, type AppRole } from '@/lib/constants';
import { handleApiError } from '@/lib/http';
import { formatDateShort } from '@/lib/dates';
import { roundMoney } from '@/lib/money';

export const dynamic = 'force-dynamic';

const ARCHIVE_ROLES: readonly AppRole[] = [...new Set<AppRole>([...ROLE_GROUPS.HR, ...ROLE_GROUPS.PAYROLL])];
const TAKE = 50;

/** Leaves decided by HR (CANCELLED ones were withdrawn, not decided). */
const LEAVE_ARCHIVE_STATUSES = [LEAVE_STATUS.APPROVED, LEAVE_STATUS.COMPLETED, LEAVE_STATUS.REJECTED];
/** Loans past the HR decision. 'APPROVED' is a legacy value kept for old rows. */
const LOAN_ARCHIVE_STATUSES = [
  LOAN_STATUS.HR_APPROVED,
  LOAN_STATUS.FINANCE_TRANSFERRED,
  LOAN_STATUS.FINANCE_APPROVED,
  LOAN_STATUS.COMPLETED,
  LOAN_STATUS.FORGIVEN,
  LOAN_STATUS.REJECTED,
  'APPROVED',
];
/** TerminationRequest / AttendanceCorrection (String columns). 'COMPLETED' kept for legacy rows. */
const DECIDED_STATUSES = ['APPROVED', 'COMPLETED', 'REJECTED'];

const employeeSelect = {
  select: { firstNameArabic: true, lastNameArabic: true, employeeId: true, department: { select: { nameArabic: true } } },
} as const;

type EmployeeLite = {
  firstNameArabic: string;
  lastNameArabic: string;
  employeeId: string;
  department: { nameArabic: string } | null;
};

const employeeFields = (e: EmployeeLite | null | undefined) => ({
  employeeName: e ? `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''}`.trim() : '',
  employeeId: e?.employeeId ?? '-',
  department: e?.department?.nameArabic ?? null,
});

export async function GET() {
  try {
    const user = await requireUser(ARCHIVE_ROLES);
    const isHr = hasRole(user, ROLE_GROUPS.HR);
    const hrOnly = <T,>(q: () => Promise<T[]>): Promise<T[]> => (isHr ? q() : Promise.resolve([]));

    const [leaves, loans, terminations, attendanceCorrections] = await Promise.all([
      hrOnly(() =>
        prisma.leave.findMany({
          where: { status: { in: LEAVE_ARCHIVE_STATUSES } },
          select: { id: true, status: true, startDate: true, endDate: true, createdAt: true, updatedAt: true, employee: employeeSelect },
          orderBy: { updatedAt: 'desc' },
          take: TAKE,
        }),
      ),
      prisma.loan.findMany({
        where: { status: { in: LOAN_ARCHIVE_STATUSES } },
        select: { id: true, status: true, amount: true, reason: true, createdAt: true, updatedAt: true, employee: employeeSelect },
        orderBy: { updatedAt: 'desc' },
        take: TAKE,
      }),
      hrOnly(() =>
        prisma.terminationRequest.findMany({
          where: { status: { in: DECIDED_STATUSES } },
          select: { id: true, status: true, terminationType: true, createdAt: true, updatedAt: true, employee: employeeSelect },
          orderBy: { updatedAt: 'desc' },
          take: TAKE,
        }),
      ),
      hrOnly(() =>
        prisma.attendanceCorrection.findMany({
          where: { status: { in: DECIDED_STATUSES } },
          select: { id: true, status: true, reason: true, createdAt: true, updatedAt: true, employee: employeeSelect },
          orderBy: { updatedAt: 'desc' },
          take: TAKE,
        }),
      ),
    ]);

    const allRequests = [
      ...leaves.map((r) => ({
        id: `leave-${r.id}`,
        type: 'LEAVE',
        title: 'طلب إجازة',
        status: r.status,
        ...employeeFields(r.employee),
        updatedAt: r.updatedAt ?? r.createdAt,
        details: `من ${formatDateShort(r.startDate)} إلى ${formatDateShort(r.endDate)}`,
      })),
      ...loans.map((r) => ({
        id: `loan-${r.id}`,
        type: 'LOAN',
        title: 'طلب سلفة مبكرة',
        status: r.status === LOAN_STATUS.REJECTED ? 'REJECTED' : 'APPROVED',
        ...employeeFields(r.employee),
        updatedAt: r.updatedAt ?? r.createdAt,
        details: `المبلغ: ${roundMoney(r.amount)} ر.س | المبرر: ${r.reason || 'بدون مبرر'}`,
      })),
      ...terminations.map((r) => ({
        id: `term-${r.id}`,
        type: 'TERMINATION',
        title: 'طلب إنهاء عقد / استقالة',
        status: r.status,
        ...employeeFields(r.employee),
        updatedAt: r.updatedAt ?? r.createdAt,
        details: `النوع: ${r.terminationType}`,
      })),
      ...attendanceCorrections.map((r) => {
        const match = r.reason?.startsWith('[طلب:') ? r.reason.match(/\[طلب:\s*(.+?)\]/) : null;
        return {
          id: `acc-${r.id}`,
          type: 'ATTENDANCE_CORRECTION',
          title: match ? match[1] : 'تصحيح بصمة / حضور',
          status: r.status,
          ...employeeFields(r.employee),
          updatedAt: r.updatedAt ?? r.createdAt,
          details: `مبرر: ${r.reason}`,
        };
      }),
    ];

    allRequests.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    return NextResponse.json({ archive: allRequests });
  } catch (err) {
    return handleApiError(err, 'incoming-requests/archive:GET');
  }
}
