import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { hasRole, requireUser, type AuthUser } from '@/lib/auth';
import { LEAVE_STATUS, LOAN_PENDING_STATUSES, ROLE_GROUPS } from '@/lib/constants';
import { handleApiError } from '@/lib/http';
import { formatMoney } from '@/lib/money';

export const dynamic = 'force-dynamic';

interface NotificationItem {
  id: string;
  title: string;
  subtitle: string;
  color: string;
  date: Date;
}

type Scope = 'all' | 'team' | 'own' | 'none';

const MANAGER_ROLES = ['BRANCH_MANAGER', 'DEPT_MANAGER'] as const;

/** Which employees' requests a user may be notified about. */
function requestScope(user: AuthUser, fullAccessRoles: readonly string[]): Scope {
  if (hasRole(user, fullAccessRoles)) return 'all';
  if (!user.employeeId) return 'none';
  if (hasRole(user, MANAGER_ROLES)) return 'team';
  return 'own';
}

function employeeFilter(scope: Scope, employeeId: string | null): Prisma.EmployeeWhereInput | undefined {
  if (scope === 'team' && employeeId) return { OR: [{ id: employeeId }, { directManagerId: employeeId }] };
  if (scope === 'own' && employeeId) return { id: employeeId };
  return undefined;
}

const employeeName = (e: { firstNameArabic: string | null; lastNameArabic: string | null } | null) =>
  e ? `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''}`.trim() || 'غير محدد' : 'غير محدد';

export async function GET() {
  try {
    const user = await requireUser();

    const loanScope = requestScope(user, [...ROLE_GROUPS.HR, ...ROLE_GROUPS.FINANCE]);
    const leaveScope = requestScope(user, ROLE_GROUPS.HR);
    const showAudit = hasRole(user, ROLE_GROUPS.ADMIN);
    const employeeSelect = { select: { firstNameArabic: true, lastNameArabic: true } } as const;

    const [pendingLoans, pendingLeaves, recentCirculars, recentLogs] = await Promise.all([
      loanScope === 'none'
        ? []
        : prisma.loan.findMany({
            where: {
              status: { in: LOAN_PENDING_STATUSES },
              isForgiven: false,
              ...(employeeFilter(loanScope, user.employeeId) ? { employee: employeeFilter(loanScope, user.employeeId) } : {}),
            },
            select: { id: true, amount: true, employeeId: true, createdAt: true, employee: employeeSelect },
            orderBy: { createdAt: 'desc' },
            take: 3,
          }),
      leaveScope === 'none'
        ? []
        : prisma.leave.findMany({
            where: {
              status: LEAVE_STATUS.PENDING,
              ...(employeeFilter(leaveScope, user.employeeId) ? { employee: employeeFilter(leaveScope, user.employeeId) } : {}),
            },
            select: { id: true, totalDays: true, employeeId: true, createdAt: true, employee: employeeSelect },
            orderBy: { createdAt: 'desc' },
            take: 3,
          }),
      prisma.circular.findMany({
        where: { status: 'PUBLISHED' },
        select: { id: true, title: true, datePublished: true },
        orderBy: { datePublished: 'desc' },
        take: 3,
      }),
      showAudit
        ? prisma.auditLog.findMany({
            select: {
              id: true,
              action: true,
              createdAt: true,
              user: { select: { name: true, employeeProfile: { select: { firstNameArabic: true } } } },
            },
            orderBy: { createdAt: 'desc' },
            take: 2,
          })
        : [],
    ]);

    const notifications: NotificationItem[] = [];

    for (const loan of pendingLoans) {
      const own = loan.employeeId === user.employeeId;
      notifications.push({
        id: `loan-${loan.id}`,
        title: own ? 'طلب سلفتك قيد الاعتماد' : 'طلب اعتماد سلفة',
        subtitle: `سلفة بقيمة ${formatMoney(loan.amount)} ر.س للموظف (${employeeName(loan.employee)})`,
        color: 'amber',
        date: loan.createdAt,
      });
    }

    for (const circ of recentCirculars) {
      notifications.push({
        id: `circular-${circ.id}`,
        title: 'تعميم إداري جديد',
        subtitle: circ.title,
        color: 'indigo',
        date: circ.datePublished,
      });
    }

    for (const leave of pendingLeaves) {
      const own = leave.employeeId === user.employeeId;
      notifications.push({
        id: `leave-${leave.id}`,
        title: own ? 'طلب إجازتك قيد الاعتماد' : 'طلب إجازة معلق',
        subtitle: `عبر الموظف (${employeeName(leave.employee)}) لمدة ${leave.totalDays} يوم`,
        color: 'emerald',
        date: leave.createdAt,
      });
    }

    for (const log of recentLogs) {
      const actorName = log.user?.name || log.user?.employeeProfile?.firstNameArabic || 'النظام';
      let title = 'إشعار نظام';
      let color = 'blue';
      if (log.action === 'CREATE_USER') title = 'صلاحية جديدة';
      if (log.action === 'LOGIN') {
        title = 'تسجيل دخول';
        color = 'slate';
      }
      if (log.action.includes('REJECT')) {
        title = 'حركة رفض وإلغاء';
        color = 'rose';
      }
      notifications.push({
        id: `log-${log.id}`,
        title,
        subtitle: `قام ${actorName} بتنفيذ '${log.action}' مسجلة بسجل التدقيق.`,
        color,
        date: log.createdAt,
      });
    }

    notifications.sort((a, b) => b.date.getTime() - a.date.getTime());
    return NextResponse.json(notifications.slice(0, 5));
  } catch (err) {
    return handleApiError(err, 'notifications:GET');
  }
}
