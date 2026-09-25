"use client";

import React from 'react';
import DashboardLayout from '@/components/DashboardLayout';
import TelecomForm, { EMPTY_TELECOM_FORM } from '../_components/TelecomForm';

export default function NewTelecomSimPage() {
  return (
    <DashboardLayout>
      <TelecomForm mode="create" initialValues={EMPTY_TELECOM_FORM} submitUrl="/api/services/telecom" submitMethod="POST" />
    </DashboardLayout>
  );
}
