"use client";

import React from 'react';
import DashboardLayout from '@/components/DashboardLayout';
import UtilityForm, { EMPTY_UTILITY_FORM } from '../_components/UtilityForm';

export default function NewUtilityMeterPage() {
  return (
    <DashboardLayout>
      <UtilityForm mode="create" initialValues={EMPTY_UTILITY_FORM} submitUrl="/api/services/utilities" submitMethod="POST" />
    </DashboardLayout>
  );
}
