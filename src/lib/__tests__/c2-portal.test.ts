// WP-4 (council-domain DOM-006 / UX-01 / UX-04 / UX-05): portal data update, HR-direct routing,
// request stages shown to the employee.
import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import type { AuthUser } from '@/lib/auth';
import {
  DATA_UPDATE_PREFIX,
  IBAN_MANUAL_UPDATE_MESSAGE,
  REQUEST_STAGE_LABELS,
  approveAttendanceCorrection,
  describeDataUpdateOutcome,
  isHrDirectRequest,
  leaveRejectionReason,
  parseDataUpdateRequest,
  rejectAttendanceCorrection,
  twoStepRequestStage,
} from '@/lib/hr-workflows';

type Db = Prisma.TransactionClient;

const HR: AuthUser = { id: 'u-hr', email: 'hr@x', role: 'HR_MANAGER', name: 'HR', avatarUrl: null, employeeId: 'emp-hr', sessionVersion: 1 };
const MANAGER: AuthUser = { id: 'u-m', email: 'm@x', role: 'DEPT_MANAGER', name: 'M', avatarUrl: null, employeeId: 'emp-mgr', sessionVersion: 1 };

const ORIGINAL = { mobileNumber: '0500000001', ibanNumber: 'SA0380000000608010167519', email: 'old@x.sa' };

/** Minimal transaction double: one PENDING correction + one employee row, records every write. */
function fakeTx(reason: string) {
  const employee = { ...ORIGINAL };
  const correction = {
    id: 'c1',
    employeeId: 'emp-1',
    date: new Date('2026-09-20T00:00:00.000Z'),
    reason,
    status: 'PENDING',
    correctionType: 'GENERAL',
    isManagerApproved: false,
    isHrApproved: false,
    employee: { id: 'emp-1', directManagerId: 'emp-mgr', branchId: 'b1', departmentId: 'd1' },
  };
  const audits: Array<{ details: string | null }> = [];
  const employeeUpdate = vi.fn(async ({ data }: { data: Record<string, string> }) => {
    Object.assign(employee, data);
    return employee;
  });
  const correctionUpdates: Array<Record<string, unknown>> = [];
  const tx = {
    attendanceCorrection: {
      findUnique: vi.fn(async () => correction),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        correctionUpdates.push(data);
        return { count: 1 };
      }),
    },
    employee: {
      update: employeeUpdate,
      findUnique: vi.fn(async () => ({ branchId: 'b1', departmentId: 'd1' })),
    },
    auditLog: { create: vi.fn(async ({ data }: { data: { details: string | null } }) => audits.push(data)) },
  };
  return { tx: tx as unknown as Db, employee, employeeUpdate, audits, correctionUpdates };
}

function auditDetails(audits: Array<{ details: string | null }>): Record<string, unknown> {
  return JSON.parse(audits[audits.length - 1]?.details ?? '{}') as Record<string, unknown>;
}

describe('approveAttendanceCorrection: data update (DOM-006)', () => {
  it('an IBAN-only request changes neither mobileNumber nor ibanNumber (updatedFields=[])', async () => {
    const f = fakeTx(`${DATA_UPDATE_PREFIX}\nالآيبان: SA4420000001234567891234`);
    const res = await approveAttendanceCorrection(f.tx, 'c1', HR, { stage: 'HR' });
    expect(res.outcome).toBe('DATA_UPDATED');
    expect(f.employeeUpdate).not.toHaveBeenCalled();
    expect(f.employee.mobileNumber).toBe(ORIGINAL.mobileNumber);
    expect(f.employee.ibanNumber).toBe(ORIGINAL.ibanNumber);
    expect(auditDetails(f.audits).updatedFields).toEqual([]);
    expect(res.message).toContain('لم يُطبَّق أي حقل تلقائياً');
    expect(res.message).toContain(IBAN_MANUAL_UPDATE_MESSAGE);
  });

  it('the legacy free-text request (old portal format) no longer leaks IBAN digits into the mobile', async () => {
    const legacy = `${DATA_UPDATE_PREFIX} تحديثات:\nالايميل: -\nالجوال: -\nاسم البنك: -\nالحساب البنكي (الآيبان): SA4420000001234567891234\n`;
    const f = fakeTx(legacy);
    const res = await approveAttendanceCorrection(f.tx, 'c1', HR, { stage: 'HR' });
    expect(f.employeeUpdate).not.toHaveBeenCalled();
    expect(f.employee.mobileNumber).toBe(ORIGINAL.mobileNumber);
    expect(auditDetails(f.audits).updatedFields).toEqual([]);
    expect(res.message).toContain('لم يُطبَّق أي حقل تلقائياً');
  });

  it('"الجوال: 0551234567" updates the mobile only and the message names «الجوال»', async () => {
    const f = fakeTx(`${DATA_UPDATE_PREFIX}\nالجوال: 0551234567`);
    const res = await approveAttendanceCorrection(f.tx, 'c1', HR, { stage: 'HR' });
    expect(f.employeeUpdate).toHaveBeenCalledTimes(1);
    expect(f.employeeUpdate.mock.calls[0][0].data).toEqual({ mobileNumber: '0551234567' });
    expect(f.employee.mobileNumber).toBe('0551234567');
    expect(f.employee.ibanNumber).toBe(ORIGINAL.ibanNumber);
    expect(f.employee.email).toBe(ORIGINAL.email);
    expect(auditDetails(f.audits).updatedFields).toEqual(['mobileNumber']);
    expect(res.message).toContain('الجوال');
    expect(res.message).not.toContain('البريد');
  });

  it('mobile + email + IBAN: applies mobile and email, never the IBAN', async () => {
    const f = fakeTx(`${DATA_UPDATE_PREFIX}\nالجوال: 0551234567\nالبريد: New@Mail.SA\nالآيبان: SA4420000001234567891234\nاسم البنك: الراجحي`);
    const res = await approveAttendanceCorrection(f.tx, 'c1', HR, { stage: 'HR' });
    expect(f.employee).toEqual({ mobileNumber: '0551234567', email: 'new@mail.sa', ibanNumber: ORIGINAL.ibanNumber });
    expect(res.message).toContain('الجوال والبريد');
    expect(res.message).toContain(IBAN_MANUAL_UPDATE_MESSAGE);
  });

  it('HR approves a general request directly, without the manager step', async () => {
    const f = fakeTx('[طلب: شهادة راتب] لجهة بنكية');
    const res = await approveAttendanceCorrection(f.tx, 'c1', HR);
    expect(res.outcome).toBe('GENERAL_APPROVED');
    expect(f.correctionUpdates[0]).toMatchObject({ status: 'APPROVED', isHrApproved: true });
  });

  it('a manager cannot approve or reject a general request (HR-only, 403)', async () => {
    const f = fakeTx('[طلب: شهادة راتب] لجهة بنكية');
    await expect(approveAttendanceCorrection(f.tx, 'c1', MANAGER, { stage: 'MANAGER' })).rejects.toMatchObject({ status: 403 });
    await expect(rejectAttendanceCorrection(f.tx, 'c1', MANAGER, 'لا')).rejects.toMatchObject({ status: 403 });
    expect(f.correctionUpdates).toHaveLength(0);
  });

  it('a manager still approves a fingerprint correction', async () => {
    const f = fakeTx('نسيت تسجيل الخروج');
    const res = await approveAttendanceCorrection(f.tx, 'c1', MANAGER, { stage: 'MANAGER' });
    expect(res.outcome).toBe('MANAGER_APPROVED');
  });
});

describe('parseDataUpdateRequest', () => {
  it('reads only tagged lines; free-text digits are ignored', () => {
    const r = parseDataUpdateRequest(`${DATA_UPDATE_PREFIX}\nملاحظات الموظف: رقمي القديم 0509999999 والهوية 1098765432`);
    expect(r).toEqual({ mobile: null, email: null, ibanRequested: false, rejected: [] });
  });

  it('rejects a mobile that is not 05XXXXXXXX, and accepts Arabic-Indic digits / spaces', () => {
    expect(parseDataUpdateRequest('الجوال: 4420000001').mobile).toBeNull();
    expect(parseDataUpdateRequest('الجوال: 4420000001').rejected).toEqual(['الجوال']);
    expect(parseDataUpdateRequest('الجوال: +966551234567').mobile).toBeNull();
    expect(parseDataUpdateRequest('الجوال: ٠٥٥١٢٣٤٥٦٧').mobile).toBe('0551234567');
    expect(parseDataUpdateRequest('الجوال: 055 123 4567').mobile).toBe('0551234567');
  });

  it('a repeated tag is ambiguous and is not applied', () => {
    const r = parseDataUpdateRequest('الجوال: 0551234567\nالجوال: 0559999999');
    expect(r.mobile).toBeNull();
    expect(r.rejected).toEqual(['الجوال']);
  });

  it('the "-" placeholder and invalid emails are not applied', () => {
    expect(parseDataUpdateRequest('البريد: -').email).toBeNull();
    expect(parseDataUpdateRequest('البريد: -').rejected).toEqual([]);
    expect(parseDataUpdateRequest('البريد: not-an-email').rejected).toEqual(['البريد']);
  });

  it('a tag must start the line ("رقم الجوال: ..." is not a tag)', () => {
    expect(parseDataUpdateRequest('رقم الجوال: 0551234567').mobile).toBeNull();
  });
});

describe('describeDataUpdateOutcome', () => {
  it('names the fields actually applied, or says none was', () => {
    expect(describeDataUpdateOutcome([], { ibanRequested: false, rejected: [] })).toBe('تم اعتماد الطلب، ولم يُطبَّق أي حقل تلقائياً.');
    expect(describeDataUpdateOutcome(['email'], { ibanRequested: false, rejected: ['الجوال'] })).toContain('لم يُطبَّق الجوال');
  });
});

describe('isHrDirectRequest', () => {
  it('matches every "[طلب:" request, not fingerprint corrections', () => {
    expect(isHrDirectRequest('[طلب: شهادة راتب] x')).toBe(true);
    expect(isHrDirectRequest(`${DATA_UPDATE_PREFIX}\nالجوال: 0551234567`)).toBe(true);
    expect(isHrDirectRequest('نسيت البصمة [طلب: x]')).toBe(false);
    expect(isHrDirectRequest(null)).toBe(false);
  });
});

describe('twoStepRequestStage', () => {
  it('maps status + manager approval to the stage the employee sees', () => {
    expect(twoStepRequestStage({ status: 'PENDING', isManagerApproved: false, needsManager: true })).toBe('MANAGER');
    expect(twoStepRequestStage({ status: 'PENDING', isManagerApproved: true, needsManager: true })).toBe('HR');
    expect(twoStepRequestStage({ status: 'PENDING', isManagerApproved: false, needsManager: false })).toBe('HR');
    expect(twoStepRequestStage({ status: 'APPROVED', isManagerApproved: true, needsManager: true })).toBe('APPROVED');
    expect(twoStepRequestStage({ status: 'COMPLETED', isManagerApproved: true, needsManager: true })).toBe('APPROVED');
    expect(twoStepRequestStage({ status: 'REJECTED', isManagerApproved: false, needsManager: true })).toBe('REJECTED');
    expect(twoStepRequestStage({ status: 'CANCELLED', isManagerApproved: false, needsManager: true })).toBe('CANCELLED');
    expect(REQUEST_STAGE_LABELS.MANAGER).toBe('بانتظار المدير');
    expect(REQUEST_STAGE_LABELS.HR).toBe('بانتظار الموارد البشرية');
  });
});

describe('leaveRejectionReason', () => {
  it('returns the last "سبب الرفض:" line appended by rejectLeave', () => {
    expect(leaveRejectionReason('[outside] ملاحظة\nسبب الرفض: ضغط العمل')).toBe('ضغط العمل');
    expect(leaveRejectionReason('سبب الرفض: أ\nسبب الرفض: ب')).toBe('ب');
    expect(leaveRejectionReason('بدون سبب')).toBeNull();
    expect(leaveRejectionReason(null)).toBeNull();
  });
});
