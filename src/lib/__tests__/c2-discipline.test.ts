// WP-1 (council-domain): integrity of the disciplinary and audit record.
import { beforeEach, describe, expect, it, vi } from 'vitest';

// No database in unit tests: capture what logAudit would write.
const { auditCreate } = vi.hoisted(() => ({
  auditCreate: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
}));
vi.mock('@/lib/prisma', () => ({ prisma: { auditLog: { create: auditCreate } } }));

import { logAudit, redact } from '@/lib/audit';
import {
  MANUAL_NOTICE_PREFIX,
  PENALTY_DAYS_MAX,
  appendDatedNote,
  buildCreateNotes,
  changedVerdictFields,
  guiltyWithoutFindings,
  liftedSuspension,
  manualNoticeProblem,
} from '@/app/api/legal/investigations/route';
import {
  DEDUCTION_DAYS_MAX,
  OCCURRENCE_WINDOW_DAYS,
  exceedsOneDayWage,
  lateViolationWarning,
  newDeductionStatus,
  occurrenceNumberFor,
} from '@/app/api/payroll-hub/route';

const d = (key: string) => new Date(`${key}T00:00:00.000Z`);
const NOW = new Date('2026-09-25T09:00:00.000Z'); // Riyadh: 2026-09-25

describe('buildCreateNotes: never records a notice the system did not send', () => {
  it('sendNotification=true adds no "تم إرسال إشعار" text', () => {
    const notes = buildCreateNotes({ sendNotification: true });
    expect(notes ?? '').not.toContain('تم إرسال إشعار');
    expect(notes).toBeNull();
  });

  it('keeps the hearing time and committee member, still without a sent-notice claim', () => {
    const notes = buildCreateNotes({
      sendNotification: true,
      committeeMember3: 'سالم',
      investigationDate: d('2026-10-01'),
      investigationTime: '10:30',
    });
    expect(notes).toContain('موعد التحقيق: 2026-10-01 الساعة 10:30');
    expect(notes).toContain('عضو لجنة 3: سالم');
    expect(notes).not.toContain('إشعار');
  });

  it('records a manual notice neutrally with method, date and who recorded it', () => {
    const notes = buildCreateNotes(
      { employeeNotifiedManually: true, notificationMethod: 'HAND_DELIVERY', notificationDate: d('2026-09-20') },
      'مدير الموارد',
    );
    expect(notes).toContain(MANUAL_NOTICE_PREFIX);
    expect(notes).toContain('خطاب مسلّم باليد');
    expect(notes).toContain('2026-09-20');
    expect(notes).toContain('سجّله مدير الموارد');
    expect(notes).toContain('خارج النظام');
    expect(notes).not.toContain('تم إرسال');
  });

  it('writes no manual-notice line when the box is not ticked', () => {
    expect(buildCreateNotes({ notificationMethod: 'EMAIL', notificationDate: d('2026-09-20') })).toBeNull();
  });
});

describe('manualNoticeProblem', () => {
  it('accepts no manual notice at all', () => {
    expect(manualNoticeProblem({}, NOW)).toBeNull();
  });
  it('requires both method and date', () => {
    expect(manualNoticeProblem({ employeeNotifiedManually: true }, NOW)).toMatch(/طريقة/);
    expect(manualNoticeProblem({ employeeNotifiedManually: true, notificationMethod: 'SMS' }, NOW)).toMatch(/تاريخ/);
  });
  it('rejects a future notice date, accepts today', () => {
    expect(manualNoticeProblem({ employeeNotifiedManually: true, notificationMethod: 'SMS', notificationDate: d('2026-09-26') }, NOW)).toMatch(/المستقبل/);
    expect(manualNoticeProblem({ employeeNotifiedManually: true, notificationMethod: 'SMS', notificationDate: d('2026-09-25') }, NOW)).toBeNull();
  });
});

describe('verdict lock', () => {
  const stored = { findings: 'ثبتت المخالفة', recommendation: 'إنذار', finalDecision: 'خصم يومين' };

  it('flags a rewrite of findings / final decision', () => {
    expect(changedVerdictFields(stored, { findings: 'نص جديد' })).toEqual(['findings']);
    expect(changedVerdictFields(stored, { finalDecision: 'فصل' })).toEqual(['finalDecision']);
  });
  it('treats the same text (or nothing) as no change', () => {
    expect(changedVerdictFields(stored, {})).toEqual([]);
    expect(changedVerdictFields(stored, { findings: ' ثبتت المخالفة ' })).toEqual([]);
  });
  it('treats writing into an empty stored field as a change too', () => {
    expect(changedVerdictFields({ findings: 'x' }, { recommendation: 'إنذار' })).toEqual(['recommendation']);
  });
  it('a guilty verdict needs written findings (request or stored)', () => {
    expect(guiltyWithoutFindings({ findings: null }, {})).toBe(true);
    expect(guiltyWithoutFindings({ findings: '   ' }, {})).toBe(true);
    expect(guiltyWithoutFindings({ findings: null }, { findings: 'ثبتت' })).toBe(false);
    expect(guiltyWithoutFindings({ findings: 'محفوظة' }, {})).toBe(false);
  });
});

describe('appendDatedNote: notes are append-only', () => {
  it('keeps the earlier text and appends a dated addendum after the verdict', () => {
    const out = appendDatedNote('موعد التحقيق: 2026-09-01', 'تم تسليم القرار', { date: '2026-09-25', by: 'سارة', afterVerdict: true });
    expect(out.startsWith('موعد التحقيق: 2026-09-01')).toBe(true);
    expect(out).toContain('[ملحق بتاريخ 2026-09-25 - سارة]: تم تسليم القرار');
  });
  it('uses a dated note before the verdict and handles empty notes', () => {
    expect(appendDatedNote(null, 'ملاحظة', { date: '2026-09-25', afterVerdict: false })).toBe('[ملاحظة بتاريخ 2026-09-25]: ملاحظة');
  });
});

describe('liftedSuspension', () => {
  it('does nothing when not suspended', () => {
    expect(liftedSuspension({ isSuspended: false, suspensionEndDate: null }, NOW)).toBeNull();
  });
  it('ends an open-ended or future suspension today', () => {
    expect(liftedSuspension({ isSuspended: true, suspensionEndDate: null }, NOW)).toEqual({ isSuspended: false, suspensionEndDate: d('2026-09-25') });
    expect(liftedSuspension({ isSuspended: true, suspensionEndDate: d('2026-10-10') }, NOW)?.suspensionEndDate).toEqual(d('2026-09-25'));
  });
  it('keeps a past end date', () => {
    expect(liftedSuspension({ isSuspended: true, suspensionEndDate: d('2026-09-01') }, NOW)?.suspensionEndDate).toEqual(d('2026-09-01'));
  });
});

describe('caps (Article 70)', () => {
  it('penalty and deduction days are capped at 5', () => {
    expect(PENALTY_DAYS_MAX).toBe(5);
    expect(DEDUCTION_DAYS_MAX).toBe(5);
  });
});

describe('occurrenceNumberFor (Article 68: 180-day window)', () => {
  it('two same-type violations 200 days apart: the second is occurrence 1', () => {
    const first = d('2026-01-01');
    const second = new Date(first.getTime() + 200 * 86_400_000);
    expect(occurrenceNumberFor(second, [first])).toBe(1);
  });
  it('counts earlier violations within 180 days (inclusive)', () => {
    const date = d('2026-09-25');
    const within = new Date(date.getTime() - OCCURRENCE_WINDOW_DAYS * 86_400_000);
    const outside = new Date(within.getTime() - 86_400_000);
    expect(occurrenceNumberFor(date, [within, d('2026-09-01'), outside])).toBe(3);
  });
  it('ignores violations dated after the new one', () => {
    expect(occurrenceNumberFor(d('2026-03-01'), [d('2026-04-01')])).toBe(1);
  });
});

describe('newDeductionStatus: more than one day wage waits for amount approval', () => {
  it('HR within one day wage takes effect as before', () => {
    expect(newDeductionStatus({ isHr: true, amount: 100, dailyWage: 100 })).toBe('DEDUCTED');
    expect(newDeductionStatus({ isHr: true, amount: 0, dailyWage: 100 })).toBe('DEDUCTED');
  });
  it('HR above one day wage (e.g. 3 days) is PENDING_AMOUNT_APPROVAL even if DEDUCTED was requested', () => {
    expect(newDeductionStatus({ isHr: true, amount: 300, dailyWage: 100 })).toBe('PENDING_AMOUNT_APPROVAL');
    expect(newDeductionStatus({ isHr: true, requested: 'DEDUCTED', amount: 300, dailyWage: 100 })).toBe('PENDING_AMOUNT_APPROVAL');
  });
  it('managers always wait for HR', () => {
    expect(newDeductionStatus({ isHr: false, amount: 0, dailyWage: 100 })).toBe('PENDING_AMOUNT_APPROVAL');
  });
  it('unknown wage: any positive amount waits', () => {
    expect(exceedsOneDayWage(1, 0)).toBe(true);
    expect(exceedsOneDayWage(0, 0)).toBe(false);
    expect(exceedsOneDayWage(100.004, 100)).toBe(false);
  });
});

describe('lateViolationWarning (Article 69)', () => {
  it('warns for a violation older than 30 days', () => {
    expect(lateViolationWarning(d('2026-08-25'), NOW)).toMatch(/المادة 69/);
  });
  it('is silent at 30 days or less', () => {
    expect(lateViolationWarning(d('2026-08-26'), NOW)).toBeNull();
    expect(lateViolationWarning(d('2026-09-25'), NOW)).toBeNull();
  });
});

describe('audit redaction of bank details', () => {
  beforeEach(() => {
    auditCreate.mockClear();
  });

  it("logAudit stores {ibanNumber:'SA..'} as '[REDACTED]'", async () => {
    await logAudit({ action: 'UPDATE', entityType: 'Employee', entityId: 'e1', details: { ibanNumber: 'SA0380000000608010167519', name: 'x' } });
    expect(auditCreate).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(String(auditCreate.mock.calls[0][0].data.details)) as Record<string, unknown>;
    expect(stored.ibanNumber).toBe('[REDACTED]');
    expect(stored.name).toBe('x');
    expect(String(auditCreate.mock.calls[0][0].data.details)).not.toContain('SA03');
  });

  it('redacts iban / accountNumber at any case and depth', () => {
    expect(redact({ IBAN: 'SA1', bank: { AccountNumber: '123', iban: 'SA2' } })).toEqual({
      IBAN: '[REDACTED]',
      bank: { AccountNumber: '[REDACTED]', iban: '[REDACTED]' },
    });
  });
});
