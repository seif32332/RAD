import { describe, expect, it } from 'vitest';
import {
  addMonthsToDateKey,
  classifyMuqeemApiError,
  displayMuqeemError,
  firstUnresolved,
  iqamaExpiryFromResponseSummary,
  iqamaRenewKeyParts,
  isDateKey,
  isEmployeeMuqeemOperation,
  isIqamaDuration,
  isUnresolvedStatus,
  looksLikeIqama,
  muqeemEligibility,
  muqeemResultMessage,
  OPERATION_GROUPS,
  parseStoredSummary,
  passportExtendKeyParts,
  passportRenewKeyParts,
  passportsEqual,
  summaryString,
  unpaidRenewalBlock,
  validatePassportExtend,
  validatePassportRenew,
  type EligibilityInput,
  type MuqeemTxView,
} from '@/app/api/employees/[id]/muqeem/logic';

const linked = { nameArabic: 'شركة مقيم', moiNumber: '7001234567', muqeemPlatformId: 'p1' };
const base: EligibilityInput = { nationality: 'مصري', iqamaOrIdNumber: '2123456789', legalCompany: linked, integrationUsable: true };

describe('muqeemEligibility', () => {
  it('eligible: non-Saudi resident of a linked company', () => {
    expect(muqeemEligibility(base)).toEqual({ eligible: true, reason: null, message: null });
  });

  it.each(['سعودي', 'SAUDI', 'السعودية', ' saudi arabia '])('Saudi (%s) is skipped with a clear message', (nationality) => {
    const r = muqeemEligibility({ ...base, nationality, iqamaOrIdNumber: '1012345678' });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('SAUDI');
    expect(r.message).toContain('سعودي');
  });

  it('Saudi check comes before the iqama format check', () => {
    expect(muqeemEligibility({ ...base, nationality: 'سعودي', iqamaOrIdNumber: '' }).reason).toBe('SAUDI');
  });

  it.each(['1012345678', '212345678', '21234567890', '', null])('invalid iqama %s -> NO_IQAMA', (iqama) => {
    expect(muqeemEligibility({ ...base, iqamaOrIdNumber: iqama }).reason).toBe('NO_IQAMA');
  });

  it('no legal company -> NO_LEGAL_COMPANY', () => {
    expect(muqeemEligibility({ ...base, legalCompany: null }).reason).toBe('NO_LEGAL_COMPANY');
  });

  it('company without moiNumber or platform -> NOT_LINKED naming the company', () => {
    const a = muqeemEligibility({ ...base, legalCompany: { ...linked, moiNumber: '  ' } });
    const b = muqeemEligibility({ ...base, legalCompany: { ...linked, muqeemPlatformId: null } });
    expect(a.reason).toBe('NOT_LINKED');
    expect(b.reason).toBe('NOT_LINKED');
    expect(a.message).toContain('شركة مقيم');
  });

  it('integration not usable -> NOT_CONFIGURED (after the link checks)', () => {
    expect(muqeemEligibility({ ...base, integrationUsable: false }).reason).toBe('NOT_CONFIGURED');
    expect(muqeemEligibility({ ...base, integrationUsable: false, legalCompany: null }).reason).toBe('NO_LEGAL_COMPANY');
  });

  it('looksLikeIqama trims', () => {
    expect(looksLikeIqama(' 2123456789 ')).toBe(true);
    expect(looksLikeIqama(undefined)).toBe(false);
  });
});

describe('dates', () => {
  it('isDateKey accepts only real calendar dates', () => {
    expect(isDateKey('2026-02-28')).toBe(true);
    expect(isDateKey('2028-02-29')).toBe(true);
    expect(isDateKey('2026-02-29')).toBe(false);
    expect(isDateKey('2026-13-01')).toBe(false);
    expect(isDateKey('26-01-01')).toBe(false);
    expect(isDateKey(null)).toBe(false);
  });

  it('addMonthsToDateKey clamps to the end of the month', () => {
    expect(addMonthsToDateKey('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsToDateKey('2026-09-26', 12)).toBe('2027-09-26');
    expect(addMonthsToDateKey('2026-11-15', 3)).toBe('2027-02-15');
    expect(addMonthsToDateKey('bad', 3)).toBeNull();
  });
});

describe('validatePassportRenew', () => {
  const today = '2026-09-26';
  const ok = {
    currentPassportNumber: 'A1234567',
    newPassportNumber: 'B7654321',
    newPassportIssueDate: '2026-09-01',
    newPassportExpiryDate: '2033-08-31',
    newPassportIssueLocation: 'القاهرة',
  };

  it('valid input -> no errors', () => {
    expect(validatePassportRenew(ok, today)).toEqual([]);
  });

  it('expiry must be after the issue date and in the future', () => {
    expect(validatePassportRenew({ ...ok, newPassportExpiryDate: '2026-09-26' }, today).join(' ')).toContain('بعد اليوم');
    expect(validatePassportRenew({ ...ok, newPassportIssueDate: '2026-09-20', newPassportExpiryDate: '2026-09-10' }, today).join(' ')).toContain(
      'بعد تاريخ إصداره',
    );
  });

  it('issue date cannot be in the future', () => {
    expect(validatePassportRenew({ ...ok, newPassportIssueDate: '2026-09-27' }, today).join(' ')).toContain('المستقبل');
  });

  it('rejects the same passport number (case-insensitive) and bad formats', () => {
    expect(validatePassportRenew({ ...ok, newPassportNumber: 'a1234567' }, today).join(' ')).toContain('مطابق');
    expect(validatePassportRenew({ ...ok, newPassportNumber: 'AB-123' }, today).join(' ')).toContain('غير صالح');
    expect(validatePassportRenew({ ...ok, newPassportNumber: 'A'.repeat(16) }, today).length).toBeGreaterThan(0);
  });

  it('requires a current passport, dates and a location', () => {
    const errors = validatePassportRenew(
      { currentPassportNumber: null, newPassportNumber: 'B1', newPassportIssueDate: '', newPassportExpiryDate: 'x', newPassportIssueLocation: ' ' },
      today,
    );
    expect(errors.length).toBe(4);
  });
});

describe('validatePassportExtend', () => {
  const today = '2026-09-26';
  it('valid when the new expiry is after today and after the current expiry', () => {
    expect(validatePassportExtend({ currentPassportNumber: 'A1', currentPassportExp: '2027-01-01', newPassportExpiryDate: '2028-01-01' }, today)).toEqual([]);
    expect(validatePassportExtend({ currentPassportNumber: 'A1', currentPassportExp: null, newPassportExpiryDate: '2028-01-01' }, today)).toEqual([]);
  });

  it('rejects past / not-later dates and a missing passport', () => {
    expect(validatePassportExtend({ currentPassportNumber: 'A1', currentPassportExp: '2027-01-01', newPassportExpiryDate: '2026-09-26' }, today).length).toBe(2);
    expect(validatePassportExtend({ currentPassportNumber: 'A1', currentPassportExp: '2027-01-01', newPassportExpiryDate: '2027-01-01' }, today)).toHaveLength(1);
    expect(validatePassportExtend({ currentPassportNumber: '', currentPassportExp: null, newPassportExpiryDate: '2028-01-01' }, today)).toHaveLength(1);
    expect(validatePassportExtend({ currentPassportNumber: 'A1', currentPassportExp: null, newPassportExpiryDate: '2028-02-30' }, today)).toHaveLength(1);
  });
});

describe('payment rule', () => {
  it('blocks while a fee request awaits the owner or finance', () => {
    expect(unpaidRenewalBlock(['PENDING_OWNER'])).toContain('لم يُسدَّد');
    expect(unpaidRenewalBlock(['PAID', 'PENDING_FINANCE'])).not.toBeNull();
  });
  it('allows with no request, a PAID or a RETURNED one', () => {
    expect(unpaidRenewalBlock([])).toBeNull();
    expect(unpaidRenewalBlock(['PAID', 'RETURNED', 'COMPLETED'])).toBeNull();
  });
});

describe('idempotency key parts', () => {
  it('iqama: employee + current expiry only (the BASE state): two durations on the same expiry collide', () => {
    expect(iqamaRenewKeyParts('e1', '2026-10-01')).toEqual(['e1', '2026-10-01']);
  });
  it('passport keys: base passport (case-normalized) + current expiry, never the new values', () => {
    expect(passportRenewKeyParts('e1', ' a123 ', '2027-01-01')).toEqual(['e1', 'A123', '2027-01-01']);
    expect(passportRenewKeyParts('e1', 'a123', null)).toEqual(['e1', 'A123', 'none']);
    expect(passportExtendKeyParts('e1', 'a123', '2027-01-01')).toEqual(['e1', 'A123', '2027-01-01']);
    expect(passportExtendKeyParts('e1', 'a123', undefined)).toEqual(['e1', 'A123', 'none']);
    expect(passportsEqual('a123', 'A123 ')).toBe(true);
    expect(passportsEqual(null, 'A123')).toBe(false);
  });
  it('operation groups block each other for passports only', () => {
    expect(OPERATION_GROUPS.IQAMA_RENEW).toEqual(['IQAMA_RENEW']);
    expect(OPERATION_GROUPS.PASSPORT_EXTEND).toContain('PASSPORT_RENEW');
  });
  it('guards', () => {
    expect(isIqamaDuration('12')).toBe(true);
    expect(isIqamaDuration('36')).toBe(false);
    expect(isIqamaDuration(12)).toBe(false);
    expect(isEmployeeMuqeemOperation('PASSPORT_RENEW')).toBe(true);
    expect(isEmployeeMuqeemOperation('EXIT_REENTRY_ISSUE')).toBe(false);
    expect(isUnresolvedStatus('UNKNOWN')).toBe(true);
    expect(isUnresolvedStatus('PENDING')).toBe(true);
    expect(isUnresolvedStatus('FAILED')).toBe(false);
  });
});

describe('stored summaries', () => {
  it('reads the new iqama expiry in any Muqeem spelling', () => {
    expect(iqamaExpiryFromResponseSummary(JSON.stringify({ newIqamaExpiryDateGre: '2027-10-01' }))).toBe('2027-10-01');
    expect(iqamaExpiryFromResponseSummary(JSON.stringify({ newIqamaExpiryDateGre: '01/10/2027' }))).toBe('2027-10-01');
    expect(iqamaExpiryFromResponseSummary(JSON.stringify({ reconciliation: {}, previous: null }))).toBeNull();
    expect(iqamaExpiryFromResponseSummary('not json')).toBeNull();
    expect(iqamaExpiryFromResponseSummary(null)).toBeNull();
  });
  it('parseStoredSummary / summaryString', () => {
    const s = parseStoredSummary('{"a":" x ","b":3}');
    expect(summaryString(s, 'a')).toBe('x');
    expect(summaryString(s, 'b')).toBeNull();
    expect(parseStoredSummary('[1]')).toBeNull();
  });
  it('displayMuqeemError drops the technical kind prefix', () => {
    expect(displayMuqeemError('REJECTED: الإقامة غير مؤهلة للخدمة')).toBe('الإقامة غير مؤهلة للخدمة');
    expect(displayMuqeemError('UNKNOWN_OUTCOME: انقطع الاتصال')).toBe('انقطع الاتصال');
    expect(displayMuqeemError('RECONCILED_FAILED: لا توجد في التقرير')).toBe('سُوّيت كغير منفذة: لا توجد في التقرير');
    expect(displayMuqeemError('RECONCILED_FAILED')).toBe('سُوّيت كغير منفذة');
    expect(displayMuqeemError('رسالة عادية')).toBe('رسالة عادية');
    expect(displayMuqeemError(null)).toBeNull();
  });
});

describe('muqeemResultMessage', () => {
  it('says whether the record was written, already current or left untouched', () => {
    expect(muqeemResultMessage('IQAMA_RENEW', 'written', false, '2027-10-01')).toBe('تم تجديد الإقامة في منصة مقيم، وحُدّث تاريخ انتهاء الإقامة في النظام إلى \u20662027-10-01\u2069.');
    expect(muqeemResultMessage('IQAMA_RENEW', 'already', true, '2027-10-01')).toContain('لم يُرسل طلب جديد');
    expect(muqeemResultMessage('IQAMA_RENEW', 'changed', false, '2027-10-01')).toContain('راجعه يدوياً');
    expect(muqeemResultMessage('PASSPORT_RENEW', 'written', false, '2030-01-01')).toContain('رقم الجواز وتاريخ انتهائه (\u20662030-01-01\u2069)');
    expect(muqeemResultMessage('PASSPORT_EXTEND', 'already', true, '2030-01-01')).toContain('سبق تمديد');
    expect(muqeemResultMessage('PASSPORT_EXTEND', 'changed', false, '2030-01-01')).toContain('راجعها يدوياً');
  });
});

describe('classifyMuqeemApiError', () => {
  it('UNKNOWN outcome must be reconciled, never retried', () => {
    const e = classifyMuqeemApiError(504, { message: 'm', details: { muqeemKind: 'UNKNOWN_OUTCOME', outcomeUnknown: true, muqeemTransactionId: 't1' } });
    expect(e).toEqual({ kind: 'UNKNOWN_OUTCOME', message: 'm', transactionId: 't1', mustReconcile: true });
  });
  it('unresolved previous attempt (ours or the core 409)', () => {
    expect(classifyMuqeemApiError(409, { message: 'x', details: { code: 'MUQEEM_UNRESOLVED', muqeemTransactionId: 't' } }).kind).toBe('UNRESOLVED');
    expect(classifyMuqeemApiError(409, { message: 'x', details: { muqeemTransactionId: 't', status: 'UNKNOWN' } }).mustReconcile).toBe(true);
  });
  it('rejections and others can be corrected and retried', () => {
    expect(classifyMuqeemApiError(422, { message: 'رفضت', details: { muqeemKind: 'REJECTED' } })).toMatchObject({ kind: 'REJECTED', mustReconcile: false });
    expect(classifyMuqeemApiError(409, { message: 'x', details: { muqeemKind: 'NOT_LINKED' } }).kind).toBe('NOT_LINKED');
    expect(classifyMuqeemApiError(503, { message: 'x', details: { muqeemKind: 'UNAVAILABLE' } }).kind).toBe('UNAVAILABLE');
    expect(classifyMuqeemApiError(500, { message: 'x', details: { code: 'MUQEEM_DONE_DB_FAILED' } }).kind).toBe('DONE_NOT_SAVED');
    expect(classifyMuqeemApiError(400, null, 'fallback')).toEqual({ kind: 'OTHER', message: 'fallback', transactionId: null, mustReconcile: false });
  });
  it('firstUnresolved filters by operation', () => {
    const tx = (operation: string, status: string): MuqeemTxView => ({
      id: `${operation}-${status}`,
      operation,
      operationLabel: operation,
      status,
      statusLabel: status,
      unresolved: isUnresolvedStatus(status),
      canReconcile: false,
      externalRef: null,
      errorMessage: null,
      reconciled: false,
      documentUrl: null,
      requestedBy: null,
      createdAt: '2026-09-26T00:00:00Z',
      completedAt: null,
    });
    const list = [tx('IQAMA_RENEW', 'SUCCEEDED'), tx('PASSPORT_EXTEND', 'UNKNOWN'), tx('IQAMA_RENEW', 'PENDING')];
    expect(firstUnresolved(list, ['IQAMA_RENEW'])?.id).toBe('IQAMA_RENEW-PENDING');
    expect(firstUnresolved(list, ['PASSPORT_RENEW', 'PASSPORT_EXTEND'])?.id).toBe('PASSPORT_EXTEND-UNKNOWN');
    expect(firstUnresolved([list[0]], ['IQAMA_RENEW'])).toBeNull();
  });
});
