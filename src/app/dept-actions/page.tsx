"use client";

import DashboardLayout from '@/components/DashboardLayout';
import ManagerWorkspace from '@/app/portal/_components/ManagerWorkspace';

const DEPT_ACTION_TABS = ['OVERTIME', 'WORK_TASK', 'PENALTY', 'JOB', 'RETURN', 'EVALUATION'] as const;

export default function DeptActionsPage() {
  return (
    <DashboardLayout>
      <ManagerWorkspace
        title="بوابة القطاع / مدير الإدارة (الإجراءات السريعة)"
        subtitle="إدارة مرؤوسيك وموظفي إدارتك بفعالية: تكليف أعمال إضافية، إيقاع جزاءات، طلب كوادر جديدة، وتسجيل إشعارات؛ بصلاحية منفصلة تماماً لمسؤولي القطاعات والإدارات."
        variant="teal"
        tabs={DEPT_ACTION_TABS}
        showLeaveLink={false}
        backLink={{ href: '/dept-manager', label: 'العودة لشاشة الاستعراض' }}
        historyTitle="سجل المعاملات والطلبات السابقة للإدارة"
      />
    </DashboardLayout>
  );
}
