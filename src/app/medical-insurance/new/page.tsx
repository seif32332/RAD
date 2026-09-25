"use client";

import React from 'react';
import DashboardLayout from '@/components/DashboardLayout';
import InsuranceForm, { EMPTY_INSURANCE_FORM } from '../_components/InsuranceForm';

export default function NewMedicalInsurancePage() {
  return (
    <DashboardLayout>
      <InsuranceForm mode="create" initialValues={EMPTY_INSURANCE_FORM} submitUrl="/api/medical-insurance" submitMethod="POST" />
    </DashboardLayout>
  );
}
