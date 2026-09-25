"use client";

import DashboardLayout from '@/components/DashboardLayout';
import ManagerWorkspace from '@/app/portal/_components/ManagerWorkspace';

export default function ManagerPortalPage() {
  return (
    <DashboardLayout>
      <ManagerWorkspace title="بوابة المشرف / المدير المباشر" />
    </DashboardLayout>
  );
}
