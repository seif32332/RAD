"use client";

import { useParams } from 'next/navigation';
import { DepartmentFormPage } from '../../_components/DepartmentForm';

export default function EditDepartmentPage() {
  const { id } = useParams<{ id: string }>();
  return <DepartmentFormPage mode="edit" id={id} />;
}
