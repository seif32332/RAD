import { describe, expect, it } from 'vitest';
import {
  MIN_VISA_DAYS,
  describeTxError,
  extendedVisaFields,
  issuedVisaFields,
  leaveIdFromDeductedFrom,
  pendingVisaSync,
  planExtension,
  planIssue,
  residentIneligibility,
  safeHijri,
  suggestReturnBefore,
  toDateKey,
  txStatusView,
  visaMuqeemKeyParts,
} from '@/app/api/visas/muqeem/shared';

const TODAY = '2026-09-26';

describe('residentIneligibility', () => {
  it('accepts a resident with a valid iqama', () => {
    expect(residentIneligibility({ nationality: 'مصري', iqamaOrIdNumber: '2412345678' })).toBeNull();
  });
  it('rejects Saudis (by nationality alias or by a national ID starting with 1)', () => {
    expect(residentIneligibility({ nationality: 'سعودي', iqamaOrIdNumber: '2412345678' })).toMatch(/سعودي/);
    expect(residentIneligibility({ nationality: 'Saudi Arabia', iqamaOrIdNumber: '2412345678' })).toMatch(/سعودي/);
    expect(residentIneligibility({ nationality: 'مصري', iqamaOrIdNumber: '1012345678' })).toMatch(/سعودي/);
  });
  it('rejects missing / malformed iqama numbers', () => {
    expect(residentIneligibility({ nationality: 'هندي', iqamaOrIdNumber: '' })).toMatch(/رقم إقامة/);
    expect(residentIneligibility({ nationality: 'هندي', iqamaOrIdNumber: '24123' })).toMatch(/رقم إقامة/);
    expect(residentIneligibility({ nationality: 'هندي', iqamaOrIdNumber: null })).toMatch(/رقم إقامة/);
  });
});

describe('leaveIdFromDeductedFrom', () => {
  it('extracts the leave uuid written by the leave workflow', () => {
    const id = '3f2b8c1e-1234-4abc-9def-0123456789ab';
    expect(leaveIdFromDeductedFrom(`مربوط آلياً بطلب الإجازة الخارجية (#${id})`)).toBe(id);
    expect(leaveIdFromDeductedFrom(`(#${id.toUpperCase()})`)).toBe(id);
  });
  it('returns null otherwise', () => {
    expect(leaveIdFromDeductedFrom(null)).toBeNull();
    expect(leaveIdFromDeductedFrom('من النظام')).toBeNull();
    expect(leaveIdFromDeductedFrom('(#not-a-uuid)')).toBeNull();
  });
});

describe('suggestReturnBefore', () => {
  it('adds the margin to the leave end date', () => {
    expect(suggestReturnBefore({ leaveEnd: '2026-10-20', today: TODAY })).toEqual({ date: '2026-11-03', source: 'leave', baseDate: '2026-10-20', marginDays: 14 });
  });
  it('uses the later of leave end and ticket return', () => {
    const s = suggestReturnBefore({ leaveEnd: new Date('2026-10-20T00:00:00Z'), ticketReturn: '2026-10-25', today: TODAY, marginDays: 5 });
    expect(s).toEqual({ date: '2026-10-30', source: 'ticket', baseDate: '2026-10-25', marginDays: 5 });
  });
  it('returns null when unknown or under the 7-day minimum', () => {
    expect(suggestReturnBefore({ today: TODAY })).toBeNull();
    expect(suggestReturnBefore({ leaveEnd: '2026-09-15', today: TODAY })).toBeNull(); // 2026-09-29: 3 days from today
    expect(suggestReturnBefore({ leaveEnd: '2026-09-19', today: TODAY })?.date).toBe('2026-10-03'); // exactly 7 days
  });
});

describe('planIssue', () => {
  it('duration mode sends visaDuration and derives the expected return date', () => {
    expect(planIssue({ mode: 'days', days: 30 }, TODAY)).toEqual({ ok: true, value: { visaDuration: 30, expectedReturnBefore: '2026-10-26', days: 30 } });
  });
  it('date mode sends the Umm al-Qura Hijri date', () => {
    const r = planIssue({ mode: 'date', returnBefore: '2026-11-10' }, TODAY);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.days).toBe(45);
      expect(r.value.visaDuration).toBeUndefined();
      expect(r.value.returnBeforeHijri).toBe(safeHijri('2026-11-10'));
      expect(r.value.returnBeforeHijri).toMatch(/^14\d{2}-\d{2}-\d{2}$/);
    }
  });
  it(`enforces the ${MIN_VISA_DAYS}-day minimum and rejects junk`, () => {
    expect(planIssue({ mode: 'days', days: 6 }, TODAY).ok).toBe(false);
    expect(planIssue({ mode: 'days', days: 7.5 }, TODAY).ok).toBe(false);
    expect(planIssue({ mode: 'days', days: Number.NaN }, TODAY).ok).toBe(false);
    expect(planIssue({ mode: 'date', returnBefore: '2026-10-02' }, TODAY).ok).toBe(false);
    expect(planIssue({ mode: 'date', returnBefore: '2026-10-03' }, TODAY).ok).toBe(true);
    expect(planIssue({ mode: 'date', returnBefore: '2026-02-30' }, TODAY).ok).toBe(false);
    expect(planIssue({ mode: 'days', days: 99999 }, TODAY).ok).toBe(false);
  });
});

describe('planExtension', () => {
  it('derives the new date from extra days', () => {
    const r = planExtension('2026-11-10', { mode: 'days', days: 30 });
    expect(r).toEqual({ ok: true, value: { extraDays: 30, newReturnBefore: '2026-12-10', newReturnBeforeHijri: safeHijri('2026-12-10') } });
  });
  it('derives extra days from a new date', () => {
    const r = planExtension(new Date('2026-11-10T00:00:00Z'), { mode: 'date', returnBefore: '2026-11-20' });
    expect(r.ok && r.value.extraDays).toBe(10);
  });
  it('rejects earlier dates, < 7 days, or an unknown current date', () => {
    expect(planExtension('2026-11-10', { mode: 'date', returnBefore: '2026-11-01' }).ok).toBe(false);
    expect(planExtension('2026-11-10', { mode: 'date', returnBefore: '2026-11-15' }).ok).toBe(false);
    expect(planExtension('2026-11-10', { mode: 'days', days: 3 }).ok).toBe(false);
    expect(planExtension(null, { mode: 'days', days: 30 }).ok).toBe(false);
  });
});

describe('visaMuqeemKeyParts', () => {
  const visa = { id: 'v1', externalVisaNumber: '7005205559', returnBefore: '2026-11-10' };
  it('issue key depends only on the visa (a changed duration cannot issue a second visa)', () => {
    expect(visaMuqeemKeyParts('EXIT_REENTRY_ISSUE', { id: 'v1' })).toEqual(['visa', 'v1']);
    expect(visaMuqeemKeyParts('EXIT_REENTRY_ISSUE', visa)).toEqual(['visa', 'v1']);
  });
  it('extend key is the BASE return date (never the new one); cancel the visa number; reprint the current date', () => {
    // +10 and +20 days requested on the same base collide: same key.
    expect(visaMuqeemKeyParts('EXIT_REENTRY_EXTEND', visa)).toEqual(['visa', 'v1', '7005205559', '2026-11-10']);
    expect(visaMuqeemKeyParts('EXIT_REENTRY_EXTEND', visa, '2026-11-10')).toEqual(['visa', 'v1', '7005205559', '2026-11-10']);
    expect(visaMuqeemKeyParts('EXIT_REENTRY_EXTEND', { ...visa, returnBefore: null })).toEqual(['visa', 'v1', '7005205559', 'none']);
    expect(visaMuqeemKeyParts('EXIT_REENTRY_CANCEL', visa)).toEqual(['visa', 'v1', '7005205559']);
    expect(visaMuqeemKeyParts('EXIT_REENTRY_REPRINT', visa)).toEqual(['visa', 'v1', '7005205559', '2026-11-10']);
    expect(visaMuqeemKeyParts('EXIT_REENTRY_REPRINT', { ...visa, returnBefore: null })).toEqual(['visa', 'v1', '7005205559', 'none']);
  });
});

describe('Muqeem response mapping', () => {
  it('issuedVisaFields reads the issuance response (Gregorian first, Hijri fallback)', () => {
    expect(issuedVisaFields({ visaNumber: '123', visaDuration: 45, visaReturnBeforeGregorianDate: '10/11/2026' })).toEqual({
      externalVisaNumber: '123',
      visaDurationDays: 45,
      returnBefore: new Date('2026-11-10T00:00:00Z'),
    });
    const h = safeHijri('2026-11-10') as string;
    expect(issuedVisaFields({ visaNumber: 987, visaReturnBeforeHijriDate: h }).returnBefore).toEqual(new Date('2026-11-10T00:00:00Z'));
    expect(issuedVisaFields(null)).toEqual({ externalVisaNumber: null, visaDurationDays: null, returnBefore: null });
    expect(issuedVisaFields({ reconciliation: {}, previous: null })).toEqual({ externalVisaNumber: null, visaDurationDays: null, returnBefore: null });
  });
  it('extendedVisaFields reads the extension response', () => {
    expect(
      extendedVisaFields({ returnBeforeAfterExtensionG: '2026-12-10', visaDurationBeforeExtension: 45, requestedExtendedDuration: 30, serviceCost: 100 }),
    ).toEqual({ returnBefore: new Date('2026-12-10T00:00:00Z'), visaDurationDays: 75, serviceCost: 100 });
    expect(extendedVisaFields({})).toEqual({ returnBefore: null, visaDurationDays: null, serviceCost: null });
  });
});

describe('describeTxError', () => {
  it('turns stored kinds into Arabic text', () => {
    expect(describeTxError('REJECTED: الإقامة غير مؤهلة للخدمة')).toBe('رفضت منصة مقيم الطلب: الإقامة غير مؤهلة للخدمة');
    expect(describeTxError('REJECTED: رفضت منصة مقيم الطلب: x')).toBe('رفضت منصة مقيم الطلب: x');
    expect(describeTxError('UNAVAILABLE')).toBe('منصة مقيم غير متاحة ولم يُنفَّذ الطلب');
    expect(describeTxError('UNAVAILABLE: Service Unavailable')).toBe('منصة مقيم غير متاحة ولم يُنفَّذ الطلب: Service Unavailable');
    expect(describeTxError('UNKNOWN_OUTCOME: انقطع الاتصال بمنصة مقيم بعد إرسال الطلب')).toBe('انقطع الاتصال بمنصة مقيم بعد إرسال الطلب');
    expect(describeTxError('RECONCILED_FAILED: تحقق من التقرير')).toBe('سُوّيت كعملية لم تُنفَّذ: تحقق من التقرير');
    expect(describeTxError('RECONCILED_FAILED')).toBe('سُوّيت كعملية لم تُنفَّذ في مقيم');
    expect(describeTxError('HTTP_400: رقم التأشيرة غير صالح')).toBe('رقم التأشيرة غير صالح');
    expect(describeTxError('نص حر')).toBe('نص حر');
    expect(describeTxError(null)).toBeNull();
    expect(describeTxError('  ')).toBeNull();
  });
});

describe('txStatusView', () => {
  const now = Date.parse('2026-09-26T10:00:00Z');
  it('maps statuses to badges and blocking flags', () => {
    expect(txStatusView({ status: 'SUCCEEDED', createdAt: '2026-09-26T09:00:00Z' }, now)).toMatchObject({ tone: 'success', blocking: false, needsReconcile: false });
    expect(txStatusView({ status: 'FAILED', createdAt: '2026-09-26T09:00:00Z' }, now)).toMatchObject({ tone: 'failed', blocking: false });
    expect(txStatusView({ status: 'UNKNOWN', createdAt: '2026-09-26T09:59:00Z' }, now)).toMatchObject({ tone: 'unknown', blocking: true, needsReconcile: true });
  });
  it('a fresh PENDING blocks without reconcile; a stale one needs reconcile', () => {
    expect(txStatusView({ status: 'PENDING', createdAt: '2026-09-26T09:58:00Z' }, now)).toMatchObject({ tone: 'pending', blocking: true, needsReconcile: false });
    expect(txStatusView({ status: 'PENDING', createdAt: '2026-09-26T09:40:00Z' }, now)).toMatchObject({ tone: 'unknown', blocking: true, needsReconcile: true });
  });
});

describe('pendingVisaSync', () => {
  const ok = (operation: string, requestSummary: string | null = null) => ({ operation, status: 'SUCCEEDED', requestSummary });
  it('detects a settled issuance that is not on the record', () => {
    expect(pendingVisaSync({ status: 'PAID', externalVisaNumber: null }, [ok('EXIT_REENTRY_ISSUE')])).toBe('EXIT_REENTRY_ISSUE');
    expect(pendingVisaSync({ status: 'PAID', externalVisaNumber: null }, [{ operation: 'EXIT_REENTRY_ISSUE', status: 'UNKNOWN' }])).toBeNull();
    expect(pendingVisaSync({ status: 'ISSUED', externalVisaNumber: '1' }, [ok('EXIT_REENTRY_ISSUE')])).toBeNull();
  });
  it('detects a settled cancellation and extension', () => {
    expect(pendingVisaSync({ status: 'ISSUED', externalVisaNumber: '1' }, [ok('EXIT_REENTRY_CANCEL')])).toBe('EXIT_REENTRY_CANCEL');
    expect(pendingVisaSync({ status: 'CANCELLED', externalVisaNumber: '1' }, [ok('EXIT_REENTRY_CANCEL')])).toBeNull();
    const ext = ok('EXIT_REENTRY_EXTEND', JSON.stringify({ previousReturnBefore: '2026-11-10', newReturnBefore: '2026-12-10' }));
    expect(pendingVisaSync({ status: 'ISSUED', externalVisaNumber: '1', returnBefore: '2026-11-10' }, [ext])).toBe('EXIT_REENTRY_EXTEND');
    expect(pendingVisaSync({ status: 'ISSUED', externalVisaNumber: '1', returnBefore: new Date('2026-12-10T00:00:00Z') }, [ext])).toBeNull();
  });
});

describe('date helpers', () => {
  it('toDateKey / safeHijri', () => {
    expect(toDateKey('2026-09-26')).toBe('2026-09-26');
    expect(toDateKey('2026-02-30')).toBeNull();
    expect(toDateKey(new Date('2026-09-26T00:00:00Z'))).toBe('2026-09-26');
    expect(safeHijri('2026-09-26')).toBe('1448-04-15');
    expect(safeHijri('junk')).toBeNull();
  });
});
