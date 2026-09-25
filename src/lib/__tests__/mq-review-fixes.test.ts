import { describe, expect, it } from 'vitest';
import {
  classifyMuqeemApiError,
  differentRequestNotice,
  docLast4,
  iqamaExpiryFromResponseSummary,
  recordStateSentence,
  summaryPassportLast4,
} from '@/app/api/employees/[id]/muqeem/logic';
import { IN_FLIGHT_MESSAGE, IN_FLIGHT_MS, featureSettlePath, isInFlightPending, last4 } from '@/lib/muqeem/tx-rules';
import { mayReadAsMuqeemDocument, type ScopedFileEntry } from '@/lib/storage';

describe('featureSettlePath: operations settled from their own screen', () => {
  it('visas, final exits and employee documents go to their screen', () => {
    expect(featureSettlePath('EXIT_REENTRY_ISSUE', 'e1')).toEqual({ path: '/visas', label: 'التأشيرات' });
    expect(featureSettlePath('EXIT_REENTRY_EXTEND', null)?.path).toBe('/visas');
    expect(featureSettlePath('FINAL_EXIT_ISSUE', 'e1')?.path).toBe('/settlements');
    expect(featureSettlePath('FINAL_EXIT_CANCEL', 'e1')?.path).toBe('/settlements');
    for (const op of ['IQAMA_RENEW', 'PASSPORT_RENEW', 'PASSPORT_EXTEND']) expect(featureSettlePath(op, 'e9')?.path).toBe('/employees/e9');
  });
  it('other operations can be settled from the generic screen', () => {
    expect(featureSettlePath('IQAMA_ISSUE', 'e1')).toBeNull();
    expect(featureSettlePath('VISIT_VISA_EXTEND', null)).toBeNull();
  });
});

describe('isInFlightPending', () => {
  const now = Date.parse('2026-09-26T10:00:00Z');
  it('only a PENDING row younger than a minute', () => {
    expect(isInFlightPending({ status: 'PENDING', createdAt: new Date(now - 5_000) }, now)).toBe(true);
    expect(isInFlightPending({ status: 'PENDING', createdAt: new Date(now - IN_FLIGHT_MS - 1) }, now)).toBe(false);
    expect(isInFlightPending({ status: 'UNKNOWN', createdAt: new Date(now - 1_000) }, now)).toBe(false);
    expect(isInFlightPending({ status: 'PENDING', createdAt: 'nonsense' }, now)).toBe(false);
  });
  it('message and masking helper', () => {
    expect(IN_FLIGHT_MESSAGE).toContain('قيد التنفيذ الآن');
    expect(last4(' ab123456 ')).toBe('3456');
    expect(docLast4('x9')).toBe('X9');
    expect(docLast4(null)).toBeNull();
  });
});

describe('differentRequestNotice (alreadyDone answered from the same base)', () => {
  it('iqama: another duration -> says it was NOT applied; same duration -> null', () => {
    const stored = { iqamaDuration: '12', currentIqamaExpiry: '2026-11-01' };
    expect(differentRequestNotice('IQAMA_RENEW', stored, { iqamaDuration: '12' })).toBeNull();
    const n = differentRequestNotice('IQAMA_RENEW', stored, { iqamaDuration: '6' }) ?? '';
    expect(n).toContain('12 شهراً');
    expect(n).toContain('لم تُطبَّق المدة المطلوبة الآن (6 شهراً)');
  });
  it('passport extend: another date -> notice with the executed date', () => {
    const stored = { passportNumberLast4: '4567', newPassportExpiryDate: '2030-01-01' };
    expect(differentRequestNotice('PASSPORT_EXTEND', stored, { newPassportExpiryDate: '2030-01-01' })).toBeNull();
    expect(differentRequestNotice('PASSPORT_EXTEND', stored, { newPassportExpiryDate: '2031-01-01' })).toContain('2030-01-01');
  });
  it('passport renew: compares the masked number, dates and place', () => {
    const stored = { newPassportNumberLast4: 'B456', newPassportExpiryDate: '2035-01-01', newPassportIssueDate: '2025-01-01', newPassportIssueLocation: 'القاهرة' };
    const same = { newPassportNumber: 'XB456', newPassportExpiryDate: '2035-01-01', newPassportIssueDate: '2025-01-01', newPassportIssueLocation: 'القاهرة' };
    expect(differentRequestNotice('PASSPORT_RENEW', stored, same)).toBeNull();
    expect(differentRequestNotice('PASSPORT_RENEW', stored, { ...same, newPassportNumber: 'X9999' })).toContain('B456');
    expect(differentRequestNotice('PASSPORT_RENEW', stored, { ...same, newPassportIssueLocation: 'الرياض' })).not.toBeNull();
    // Rows written before masking kept the full number.
    expect(differentRequestNotice('PASSPORT_RENEW', { newPassportNumber: 'ZZB456', newPassportExpiryDate: '2035-01-01' }, same)).toBeNull();
  });
  it('record state sentences never claim the new request', () => {
    expect(recordStateSentence('IQAMA_RENEW', 'written', '2027-11-01')).toContain('وفق التجديد المنفذ');
    expect(recordStateSentence('IQAMA_RENEW', null, null)).toContain('سوِّ العملية');
    expect(recordStateSentence('PASSPORT_RENEW', null, null)).toContain('حدّث بيانات الجواز');
    expect(recordStateSentence('PASSPORT_EXTEND', 'changed', '2030-01-01')).toContain('راجعها يدوياً');
  });
});

describe('masked summaries and reconciled results', () => {
  it('summaryPassportLast4 reads the masked field or an old full number', () => {
    expect(summaryPassportLast4({ currentPassportNumberLast4: 'a123' }, 'currentPassportNumber')).toBe('A123');
    expect(summaryPassportLast4({ currentPassportNumber: 'M1234567' }, 'currentPassportNumber')).toBe('4567');
    expect(summaryPassportLast4(null, 'currentPassportNumber')).toBeNull();
  });
  it('iqamaExpiryFromResponseSummary also reads the date entered at reconciliation', () => {
    expect(iqamaExpiryFromResponseSummary(JSON.stringify({ newIqamaExpiryDateGre: '2027-10-01' }))).toBe('2027-10-01');
    expect(iqamaExpiryFromResponseSummary(JSON.stringify({ reconciliation: { details: { newIqamaExpiryDate: '2027-12-31' } }, previous: null }))).toBe('2027-12-31');
    expect(iqamaExpiryFromResponseSummary(JSON.stringify({ reconciliation: { note: 'x' } }))).toBeNull();
  });
  it('an in-flight 409 is not a reconcile case', () => {
    const e = classifyMuqeemApiError(409, { message: IN_FLIGHT_MESSAGE, details: { code: 'MUQEEM_UNRESOLVED', inProgress: true, muqeemTransactionId: 't1', status: 'PENDING' } });
    expect(e).toMatchObject({ kind: 'UNRESOLVED', mustReconcile: false, transactionId: 't1', message: IN_FLIGHT_MESSAGE });
    expect(classifyMuqeemApiError(409, { message: 'x', details: { code: 'MUQEEM_UNRESOLVED', muqeemTransactionId: 't1', status: 'UNKNOWN' } }).mustReconcile).toBe(true);
  });
});

describe('mayReadAsMuqeemDocument (visa PDFs for GOV_RELATIONS, nothing else)', () => {
  const entry = (over: Partial<ScopedFileEntry> = {}): ScopedFileEntry => ({ uploadedById: 'u-hr', employeeId: 'emp-x', category: 'IDENTITY', isPublic: false, ...over });
  it('GOV_RELATIONS: only IDENTITY files, then subject to the Muqeem reference lookup', () => {
    expect(mayReadAsMuqeemDocument({ role: 'GOV_RELATIONS' }, entry())).toBe(true);
    expect(mayReadAsMuqeemDocument({ role: 'GOV_RELATIONS' }, entry({ category: 'PASSPORT' }))).toBe(false);
    expect(mayReadAsMuqeemDocument({ role: 'GOV_RELATIONS' }, entry({ category: 'BANK' }))).toBe(false);
    expect(mayReadAsMuqeemDocument({ role: 'GOV_RELATIONS' }, entry({ isPublic: true }))).toBe(false);
    expect(mayReadAsMuqeemDocument({ role: 'GOV_RELATIONS' }, null)).toBe(false);
  });
  it('no other role gains anything from it', () => {
    for (const role of ['EMPLOYEE', 'BRANCH_MANAGER', 'DEPT_MANAGER', 'LEGAL_ADMIN', 'PURCHASING_AGENT']) {
      expect(mayReadAsMuqeemDocument({ role }, entry())).toBe(false);
    }
  });
});
