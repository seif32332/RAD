import { describe, expect, it } from 'vitest';
import {
  cancelBlockers,
  cancelKeyParts,
  cancelledVisaNumber,
  deriveFinalExitState,
  extractFinalExitDetails,
  finalExitExtraWarnings,
  isReconcilable,
  issueBlockers,
  issueKeyParts,
  normalizeVisaNumberInput,
  parseSummary,
  type FinalExitEligibilityInput,
  type FinalExitTx,
} from '@/app/api/settlements/[id]/muqeem/_logic';

let seq = 0;
const at = (min: number) => new Date(Date.UTC(2026, 8, 1, 10, min));
function tx(p: Partial<FinalExitTx> & Pick<FinalExitTx, 'operation' | 'status'>, min = seq++): FinalExitTx {
  return {
    id: `t${min}`,
    externalRef: null,
    errorMessage: null,
    requestSummary: null,
    responseSummary: null,
    createdAt: at(min),
    completedAt: at(min),
    ...p,
  };
}
const ISSUE = 'FINAL_EXIT_ISSUE';
const CANCEL = 'FINAL_EXIT_CANCEL';

describe('deriveFinalExitState', () => {
  it('no transactions -> NONE', () => {
    const s = deriveFinalExitState([]);
    expect(s.phase).toBe('NONE');
    expect(s.visaNumber).toBeNull();
    expect(s.successfulCancels).toBe(0);
  });

  it('failed issue -> FAILED with its error', () => {
    const s = deriveFinalExitState([tx({ operation: ISSUE, status: 'FAILED', errorMessage: 'REJECTED: غير مؤهلة' })]);
    expect(s.phase).toBe('FAILED');
    expect(s.lastError).toContain('غير مؤهلة');
  });

  it('succeeded issue -> ISSUED with the visa number', () => {
    const s = deriveFinalExitState([
      tx({ operation: ISSUE, status: 'FAILED' }, 1),
      tx({ operation: ISSUE, status: 'SUCCEEDED', externalRef: '8123456789' }, 2),
    ]);
    expect(s.phase).toBe('ISSUED');
    expect(s.visaNumber).toBe('8123456789');
    expect(s.activeIssue?.id).toBe('t2');
    expect(s.lastError).toBeNull();
  });

  it('issue then cancel of the same number -> CANCELLED, one successful cancel', () => {
    const s = deriveFinalExitState([
      tx({ operation: CANCEL, status: 'SUCCEEDED', externalRef: '811' }, 5),
      tx({ operation: ISSUE, status: 'SUCCEEDED', externalRef: '811' }, 4),
    ]);
    expect(s.phase).toBe('CANCELLED');
    expect(s.visaNumber).toBeNull();
    expect(s.successfulCancels).toBe(1);
  });

  it('a cancel of ANOTHER number does not cancel the active visa', () => {
    const s = deriveFinalExitState([
      tx({ operation: ISSUE, status: 'SUCCEEDED', externalRef: '811' }, 1),
      tx({ operation: CANCEL, status: 'SUCCEEDED', externalRef: '999' }, 2),
    ]);
    expect(s.phase).toBe('ISSUED');
    expect(s.visaNumber).toBe('811');
  });

  it('cancel reconciled without externalRef uses requestSummary.feVisaNumber', () => {
    const cancelRow = tx({ operation: CANCEL, status: 'SUCCEEDED', requestSummary: JSON.stringify({ feVisaNumber: '811' }) }, 2);
    expect(cancelledVisaNumber(cancelRow)).toBe('811');
    const s = deriveFinalExitState([tx({ operation: ISSUE, status: 'SUCCEEDED', externalRef: '811' }, 1), cancelRow]);
    expect(s.phase).toBe('CANCELLED');
  });

  it('re-issue after cancel -> ISSUED with the new number', () => {
    const s = deriveFinalExitState([
      tx({ operation: ISSUE, status: 'SUCCEEDED', externalRef: '811' }, 1),
      tx({ operation: CANCEL, status: 'SUCCEEDED', externalRef: '811' }, 2),
      tx({ operation: ISSUE, status: 'SUCCEEDED', externalRef: '822' }, 3),
    ]);
    expect(s.phase).toBe('ISSUED');
    expect(s.visaNumber).toBe('822');
    expect(s.successfulCancels).toBe(1);
  });

  it('UNKNOWN or PENDING wins over everything (blocks)', () => {
    const s = deriveFinalExitState([
      tx({ operation: ISSUE, status: 'SUCCEEDED', externalRef: '811' }, 1),
      tx({ operation: CANCEL, status: 'UNKNOWN' }, 2),
    ]);
    expect(s.phase).toBe('UNDETERMINED');
    expect(s.undetermined?.id).toBe('t2');
    expect(deriveFinalExitState([tx({ operation: ISSUE, status: 'PENDING' })]).phase).toBe('UNDETERMINED');
  });

  it('ignores other operations', () => {
    expect(deriveFinalExitState([tx({ operation: 'EXIT_REENTRY_ISSUE', status: 'UNKNOWN' })]).phase).toBe('NONE');
  });
});

describe('idempotency key parts', () => {
  it('stable per settlement and generation', () => {
    expect(issueKeyParts('s1', 0)).toEqual(['settlement', 's1']);
    expect(issueKeyParts('s1', 0)).toEqual(issueKeyParts('s1', 0));
    expect(issueKeyParts('s1', 2)).toEqual(['settlement', 's1', 'reissue', '2']);
    expect(cancelKeyParts('s1', '811')).toEqual(['settlement', 's1', '811']);
  });
});

describe('issueBlockers', () => {
  const ok: FinalExitEligibilityInput = {
    settlement: { type: 'END_OF_SERVICE', status: 'OWNER_APPROVED' },
    employee: { nationality: 'مصري', iqamaOrIdNumber: '2123456789' },
    company: { name: 'شركة', linked: true },
    muqeemUsable: true,
    state: deriveFinalExitState([]),
  };
  const codes = (o: Partial<FinalExitEligibilityInput>) => issueBlockers({ ...ok, ...o }).map((b) => b.code);

  it('eligible when all conditions hold (OWNER_APPROVED or PAID)', () => {
    expect(codes({})).toEqual([]);
    expect(codes({ settlement: { type: 'END_OF_SERVICE', status: 'PAID' } })).toEqual([]);
  });
  it('leave settlement / pending / rejected are refused', () => {
    expect(codes({ settlement: { type: 'LEAVE_SETTLEMENT', status: 'PAID' } })).toEqual(['NOT_END_OF_SERVICE']);
    expect(codes({ settlement: { type: 'END_OF_SERVICE', status: 'PENDING_APPROVAL' } })).toEqual(['SETTLEMENT_STATUS']);
    const msg = issueBlockers({ ...ok, settlement: { type: 'END_OF_SERVICE', status: 'REJECTED' } })[0].message;
    expect(msg).toContain('مرفوضة');
  });
  it('Saudi employees are not residents (any legacy spelling)', () => {
    expect(codes({ employee: { nationality: 'سعودي', iqamaOrIdNumber: '1123456789' } })).toEqual(['SAUDI']);
    expect(codes({ employee: { nationality: 'SAUDI', iqamaOrIdNumber: '1123456789' } })).toEqual(['SAUDI']);
  });
  it('iqama must match ^2\\d{9}$', () => {
    expect(codes({ employee: { nationality: 'هندي', iqamaOrIdNumber: '1123456789' } })).toEqual(['INVALID_IQAMA']);
    expect(codes({ employee: { nationality: 'هندي', iqamaOrIdNumber: null } })).toEqual(['INVALID_IQAMA']);
  });
  it('company missing / not linked / integration off', () => {
    expect(codes({ company: null })).toEqual(['NO_LEGAL_COMPANY']);
    expect(codes({ company: { name: 'س', linked: false } })).toEqual(['NOT_LINKED']);
    expect(issueBlockers({ ...ok, company: { name: 'شركة س', linked: false } })[0].message).toContain('«شركة س»');
    expect(codes({ muqeemUsable: false })).toEqual(['NOT_CONFIGURED']);
  });
  it('already issued / undetermined', () => {
    const issued = deriveFinalExitState([tx({ operation: ISSUE, status: 'SUCCEEDED', externalRef: '811' })]);
    expect(codes({ state: issued })).toEqual(['ALREADY_ISSUED']);
    const unknown = deriveFinalExitState([tx({ operation: ISSUE, status: 'UNKNOWN' })]);
    expect(codes({ state: unknown })).toEqual(['UNDETERMINED']);
  });
  it('re-issue allowed after a successful cancel', () => {
    const cancelled = deriveFinalExitState([
      tx({ operation: ISSUE, status: 'SUCCEEDED', externalRef: '811' }, 1),
      tx({ operation: CANCEL, status: 'SUCCEEDED', externalRef: '811' }, 2),
    ]);
    expect(codes({ state: cancelled })).toEqual([]);
  });
});

describe('cancelBlockers', () => {
  const base = {
    employee: { nationality: 'مصري', iqamaOrIdNumber: '2123456789' },
    company: { name: 'شركة', linked: true },
    muqeemUsable: true,
  };
  it('needs an issued visa with a number', () => {
    expect(cancelBlockers({ ...base, state: deriveFinalExitState([]) }).length).toBe(1);
    const issued = deriveFinalExitState([tx({ operation: ISSUE, status: 'SUCCEEDED', externalRef: '811' })]);
    expect(cancelBlockers({ ...base, state: issued })).toEqual([]);
    const noNumber = deriveFinalExitState([tx({ operation: ISSUE, status: 'SUCCEEDED', externalRef: null })]);
    expect(noNumber.phase).toBe('ISSUED');
    expect(cancelBlockers({ ...base, state: noNumber }).length).toBe(1);
  });
  it('undetermined blocks cancel', () => {
    const s = deriveFinalExitState([tx({ operation: ISSUE, status: 'UNKNOWN' })]);
    expect(cancelBlockers({ ...base, state: s }).map((b) => b.code)).toEqual(['UNDETERMINED']);
  });
});

describe('extractFinalExitDetails', () => {
  const resp = {
    mainResident: {
      finalExitVisa: {
        exitBeforeG: '2026-11-25',
        exitBeforeH: '1448-06-05',
        issuanceDateG: '2026-09-26',
        issuanceDateH: '1448-04-15',
        visaNumber: '8000000123',
        visaType: 'Final Exit',
      },
      iqamaNumber: '2123456789',
      nationality: 'مصر',
      occupation: 'محاسب',
      passportNumber: 'A1',
      residentName: 'مقيم',
      visaNumber: '7000000001',
    },
  };
  it('prefers finalExitVisa.visaNumber and parses the dates', () => {
    const d = extractFinalExitDetails(resp);
    expect(d.visaNumber).toBe('8000000123');
    expect(d.exitBefore?.toISOString()).toBe('2026-11-25T00:00:00.000Z');
    expect(d.exitBeforeHijri).toBe('1448-06-05');
    expect(d.issuedOn?.toISOString()).toBe('2026-09-26T00:00:00.000Z');
    expect(d.residentName).toBe('مقيم');
  });
  it('falls back to mainResident.visaNumber, accepts the stored {response} wrapper, tolerates junk', () => {
    expect(extractFinalExitDetails({ mainResident: { visaNumber: 123 } }).visaNumber).toBe('123');
    expect(extractFinalExitDetails({ response: resp, pdfError: 'x' }).visaNumber).toBe('8000000123');
    expect(extractFinalExitDetails(null).visaNumber).toBeNull();
    expect(extractFinalExitDetails({ mainResident: { finalExitVisa: { visaNumber: 'abc' } } }).visaNumber).toBeNull();
  });
});

describe('small helpers', () => {
  it('parseSummary', () => {
    expect(parseSummary('{"a":1}')).toEqual({ a: 1 });
    expect(parseSummary('[1]')).toBeNull();
    expect(parseSummary('nope')).toBeNull();
    expect(parseSummary(null)).toBeNull();
  });
  it('normalizeVisaNumberInput', () => {
    expect(normalizeVisaNumberInput(' 81-23 ')).toBe('8123');
    expect(normalizeVisaNumberInput('٨١٢٣')).toBe('8123');
    expect(normalizeVisaNumberInput('81a')).toBeNull();
    expect(normalizeVisaNumberInput('')).toBeNull();
  });
  it('isReconcilable: UNKNOWN always, PENDING after 10 minutes', () => {
    const now = at(30);
    expect(isReconcilable({ status: 'UNKNOWN', createdAt: at(29) }, now)).toBe(true);
    expect(isReconcilable({ status: 'PENDING', createdAt: at(25) }, now)).toBe(false);
    expect(isReconcilable({ status: 'PENDING', createdAt: at(10) }, now)).toBe(true);
    expect(isReconcilable({ status: 'FAILED', createdAt: at(0) }, now)).toBe(false);
  });
  it('finalExitExtraWarnings', () => {
    expect(finalExitExtraWarnings({ settlementStatus: 'PAID', loans: [] })).toEqual([]);
    const w = finalExitExtraWarnings({ settlementStatus: 'OWNER_APPROVED', loans: [{ remainingAmount: 500 }, { remainingAmount: 250.5 }] });
    expect(w).toHaveLength(2);
    expect(w[1]).toContain('750.50');
  });
});
