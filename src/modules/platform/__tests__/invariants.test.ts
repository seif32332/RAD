// Unit tests of the invariant engine without a database (P1-FND-INV): the registry against the
// constitution, findings and fingerprints, the L4 gate filter and error, and the classification policy
// (second person, beneficiary, single operator, INV-PAY-03). The transactions, idempotency and the
// reconcile writes are proven against PostgreSQL in invariants.it.test.ts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { checkOrg01, type ReconciliationResult } from '@/lib/reconciliation/checks';
import { HttpError } from '@/lib/http';
import {
  BlockingDiscrepanciesError,
  GATED_OPERATIONS,
  INVARIANTS,
  IntegrityInvariantPolicyError,
  assertNoBlockingDiscrepancies,
  blockingWhere,
  decideApproveExplanation,
  decideApproveWaiver,
  decideExplain,
  decideOwnerConfirmation,
  decideRejectPending,
  decideResolve,
  decideWaiver,
  effectiveSeverity,
  findingsOf,
  fingerprintOf,
  invariantById,
  isBlocking,
  measuredInvariants,
  type DiscrepancyState,
} from '@/modules/platform';

const DOC = readFileSync(path.join(process.cwd(), 'docs/architecture/ARCHITECTURE_INVARIANTS.md'), 'utf8');
const def = (id: string) => {
  const d = invariantById(id);
  if (!d) throw new Error(id);
  return d;
};

describe('registry against ARCHITECTURE_INVARIANTS §4.2.1 and §4.3', () => {
  it('defines every INV id of the §4.2.1 table exactly once, with its default severity', () => {
    const table = [...DOC.matchAll(/^\| (INV-[A-Z]+-\d{2}) \|[^|]*\|[^|]*\| (INFO|WARNING|HIGH|BLOCKING)/gm)].map((m) => [m[1], m[2]]);
    expect(table.length).toBeGreaterThan(20);
    expect(INVARIANTS.map((d) => d.id).sort()).toEqual(table.map(([id]) => id).sort());
    for (const [id, severity] of table) expect(def(id).severity, id).toBe(severity);
  });

  it('the integrity invariants are exactly the fixed list of §4.3 rule 2 (DEC-PO-120 + INV-PAY-06 of DEC-PO-122)', () => {
    const fixed = ['INV-EFF-01', 'INV-ORG-01', 'INV-PAY-01', 'INV-PAY-02', 'INV-PAY-03', 'INV-PAY-04', 'INV-PAY-05', 'INV-PAY-06', 'INV-GOSI-01', 'INV-ATT-02', 'INV-LEV-01', 'INV-EOS-01', 'INV-DOC-01', 'INV-SCOPE-01'];
    expect(INVARIANTS.filter((d) => d.integrity).map((d) => d.id).sort()).toEqual([...fixed].sort());
  });

  it('measures the five phase-0 invariants; only INV-PAY-03 has a blocking owner confirmation', () => {
    expect(measuredInvariants().map((d) => d.id)).toEqual(['INV-LCY-01', 'INV-ORG-01', 'INV-PAY-01', 'INV-PAY-02', 'INV-DOC-01']);
    expect(INVARIANTS.filter((d) => d.ownerConfirmationBlocks).map((d) => d.id)).toEqual(['INV-PAY-03']);
  });

  it('is frozen and every blocking scope names a gated operation', () => {
    expect(Object.isFrozen(INVARIANTS)).toBe(true);
    expect(Object.isFrozen(INVARIANTS[0])).toBe(true);
    for (const d of INVARIANTS) for (const op of d.blocks) expect(GATED_OPERATIONS).toContain(op);
    // A report finding never stops payroll (§4.3 rule 3); INV-DOC-01 stops issuing documents only.
    expect(def('INV-RPT-01').blocks).toEqual([]);
    expect(def('INV-DOC-01').blocks).toEqual(['document.issue']);
  });

  it('a company may not lower an integrity invariant (DEC-PO-120); a policy invariant may be adjusted', () => {
    expect(() => effectiveSeverity(def('INV-PAY-01'), 'BLOCKING', 'WARNING')).toThrow(IntegrityInvariantPolicyError);
    expect(effectiveSeverity(def('INV-PAY-01'), 'BLOCKING', 'BLOCKING')).toBe('BLOCKING');
    expect(effectiveSeverity(def('INV-LCY-01'), 'HIGH', 'WARNING')).toBe('WARNING');
    expect(effectiveSeverity(def('INV-LCY-01'), 'HIGH')).toBe('HIGH');
  });

  it('blocking = a blocking scope and a severity of HIGH or more', () => {
    expect(isBlocking(def('INV-PAY-01'), 'BLOCKING')).toBe(true);
    expect(isBlocking(def('INV-PAY-01'), 'WARNING')).toBe(false);
    expect(isBlocking(def('INV-LCY-01'), 'HIGH')).toBe(true);
    expect(isBlocking(def('INV-WF-01'), 'WARNING')).toBe(false);
    expect(isBlocking(def('INV-OFF-01'), 'HIGH')).toBe(false);
  });
});

describe('findings and fingerprints', () => {
  const db = (rows: Record<string, unknown[]>) => {
    const out: Record<string, unknown> = {};
    for (const m of ['employee', 'branch', 'department']) out[m] = { findMany: vi.fn(async () => rows[m] ?? []) };
    return out;
  };
  const emp = { legalCompanyId: 'CO-L', actualCompanyId: 'CO-A', branchId: 'BR-A', departmentId: null, isTerminated: false, terminationDate: null, employmentStatus: 'ACTIVE', exitReason: null };

  it('one finding per violating row, with the company, the employee and a stable fingerprint', async () => {
    const results = await checkOrg01(
      db({
        employee: [{ id: 'E-OK', ...emp }, { id: 'E-BAD', ...emp, branchId: 'BR-B' }, { id: 'E-NOCO', ...emp, actualCompanyId: null }],
        branch: [{ id: 'BR-A', companyId: 'CO-A' }, { id: 'BR-B', companyId: 'CO-B' }],
      }),
    );
    const f = findingsOf(def('INV-ORG-01'), results);
    expect(f.map((x) => [x.entityId, x.companyId, x.subjectEmployeeId, x.entityType, x.checkId, x.actualValue.tag])).toEqual([
      ['E-BAD', 'CO-A', 'E-BAD', 'Employee', 'branch-not-in-actual-company', 'OTHER_COMPANY'],
      ['E-NOCO', null, 'E-NOCO', 'Employee', 'branch-not-in-actual-company', 'NO_ACTUAL_COMPANY'],
    ]);
    expect(f[0]).toMatchObject({ severity: 'BLOCKING', blocking: true, blocks: ['payroll.approve', 'payroll.export', 'payroll.pay', 'settlement.pay'], domain: 'org' });
    expect(f[0].fingerprint).toBe(fingerprintOf({ ruleId: 'INV-ORG-01', checkId: 'branch-not-in-actual-company', entityType: 'Employee', entityId: 'E-BAD', period: null }));
    expect(fingerprintOf({ ruleId: 'INV-ORG-01', checkId: 'x', entityType: 'Employee', entityId: 'E', period: '2026-01' })).not.toBe(
      fingerprintOf({ ruleId: 'INV-ORG-01', checkId: 'x', entityType: 'Employee', entityId: 'E', period: '2026-02' }),
    );
  });

  it('INFO results are counted, never recorded as discrepancies', () => {
    const info = { invariant: 'INV-LCY-01', check: 'terminated-without-settlement', severity: 'INFO', count: 3 } as unknown as ReconciliationResult;
    expect(findingsOf(def('INV-LCY-01'), [info])).toEqual([]);
  });
});

describe('L4 gate (§4.3 rule 3)', () => {
  it('filters OPEN + blocking + the operation, scoped to the company, the employees and the period', () => {
    expect(blockingWhere({ operation: 'payroll.approve', companyId: 'A', period: '2026-09' })).toEqual({
      status: 'OPEN',
      blocking: true,
      blocks: { has: 'payroll.approve' },
      AND: [{ companyId: 'A' }, { OR: [{ period: null }, { period: '2026-09' }] }],
    });
    expect(blockingWhere({ operation: 'settlement.pay', companyId: 'A', employeeIds: ['e1', 'e1'] }).AND).toEqual([
      { OR: [{ companyId: 'A', subjectEmployeeId: null }, { subjectEmployeeId: { in: ['e1'] } }] },
    ]);
  });

  it('refuses an unknown operation, a missing company and a malformed period', () => {
    expect(() => blockingWhere({ operation: 'payroll.approveAll' as never, companyId: 'A' })).toThrow(/unknown operation/);
    expect(() => blockingWhere({ operation: 'payroll.approve', companyId: ' ' })).toThrow(/companyId/);
    expect(() => blockingWhere({ operation: 'payroll.approve', companyId: 'A', period: '2026-9' })).toThrow(/period/);
  });

  it('throws a 409 listing the blockers, and passes when there is none', async () => {
    const blocker = { id: 'd1', ruleId: 'INV-PAY-01', checkId: 'net-mismatch', severity: 'BLOCKING', companyId: 'A', subjectEmployeeId: 'e1', entityType: 'Payroll', entityId: 'p1', period: '2026-09', pendingAction: null };
    const withRows = { discrepancy: { findMany: vi.fn(async () => [blocker]), count: vi.fn(async () => 1) } };
    const err = await assertNoBlockingDiscrepancies(withRows as never, { operation: 'payroll.approve', companyId: 'A' }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockingDiscrepanciesError);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(409);
    expect(err.details).toMatchObject({ code: 'BLOCKING_DISCREPANCIES', operation: 'payroll.approve', total: 1, blockers: [blocker] });
    const empty = { discrepancy: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) } };
    await expect(assertNoBlockingDiscrepancies(empty as never, { operation: 'payroll.approve', companyId: 'A' })).resolves.toBeUndefined();
  });
});

describe('classification policy (§4.3 rules 2 and 5, ADR-0002 #1)', () => {
  const now = new Date('2026-09-28T10:00:00Z');
  const row = (over: Partial<DiscrepancyState> = {}): DiscrepancyState => ({
    id: 'd1', ruleId: 'INV-ORG-01', status: 'OPEN', blocking: true, subjectEmployeeId: 'emp-x', pendingAction: null,
    explainedById: null, waivedById: null, selfActSingleOperator: false, ownerConfirmation: null, ...over,
  });
  const u1 = { userId: 'u1', employeeId: 'emp-1' };
  const u2 = { userId: 'u2', employeeId: 'emp-2' };
  const text = { explanation: 'البنك رفض التحويل لأن الآيبان مغلق', reference: 'BANK-REPLY-77' };

  it('a blocking finding: the explanation waits for a second person; a non-blocking policy finding is explained at once', () => {
    const blocking = decideExplain(row(), def('INV-ORG-01'), u1, 'ENFORCED', text, now);
    expect(blocking).toMatchObject({ status: 'OPEN', pendingAction: 'EXPLANATION', events: ['platform.discrepancy.explanationProposed'] });
    const warning = decideExplain(row({ ruleId: 'INV-LCY-01', blocking: false }), def('INV-LCY-01'), u1, 'ENFORCED', text, now);
    expect(warning).toMatchObject({ status: 'EXPLAINED', pendingAction: null });
    // An integrity invariant needs the second person even for a non-blocking sub-check.
    expect(decideExplain(row({ ruleId: 'INV-PAY-01', blocking: false }), def('INV-PAY-01'), u1, 'ENFORCED', text, now).pendingAction).toBe('EXPLANATION');
  });

  it('an explanation needs a text and a reference', () => {
    expect(() => decideExplain(row(), def('INV-ORG-01'), u1, 'ENFORCED', { explanation: 'قصير', reference: 'R' }, now)).toThrow(HttpError);
    expect(() => decideExplain(row(), def('INV-ORG-01'), u1, 'ENFORCED', { ...text, reference: '  ' }, now)).toThrow(HttpError);
  });

  it('the second person must differ from the first, and the beneficiary is never one of them', () => {
    const pending = row({ pendingAction: 'EXPLANATION', explainedById: 'u1' });
    expect(() => decideApproveExplanation(pending, u1, now)).toThrow(/شخص ثانٍ/);
    expect(decideApproveExplanation(pending, u2, now)).toMatchObject({ status: 'EXPLAINED', data: { explanationApprovedById: 'u2' } });
    expect(() => decideExplain(row({ subjectEmployeeId: 'emp-1' }), def('INV-ORG-01'), u1, 'ENFORCED', text, now)).toThrow(/صاحب الاختلاف/);
    expect(() => decideApproveExplanation({ ...pending, subjectEmployeeId: 'emp-2' }, u2, now)).toThrow(/صاحب الاختلاف/);
  });

  it('a waiver always needs two people; its approval alerts the owner (event)', () => {
    const asked = decideWaiver(row(), def('INV-ORG-01'), u1, 'ENFORCED', { reason: 'فرق توقيت مع البنك موثق' }, now);
    expect(asked).toMatchObject({ status: 'OPEN', pendingAction: 'WAIVER' });
    const pending = row({ pendingAction: 'WAIVER', waivedById: 'u1' });
    expect(() => decideApproveWaiver(pending, u1, now)).toThrow(HttpError);
    expect(decideApproveWaiver(pending, u2, now)).toMatchObject({ status: 'WAIVED', events: ['platform.discrepancy.waived'] });
    expect(decideRejectPending(pending, u2)).toMatchObject({ status: 'OPEN', pendingAction: null, data: { waivedById: null } });
  });

  it('SINGLE_OPERATOR: the sole operator acts alone, recorded, and the owner is asked to confirm', () => {
    const d = decideWaiver(row(), def('INV-ORG-01'), u1, 'SINGLE_OPERATOR', { reason: 'مشغّل وحيد: فرق مثبت بالمرجع' }, now);
    expect(d).toMatchObject({ status: 'WAIVED', ownerConfirmation: 'PENDING', data: { selfActSingleOperator: true } });
    expect(d.events).toEqual(['platform.discrepancy.waived', 'platform.discrepancy.ownerConfirmationRequested']);
    // The beneficiary rule still applies.
    expect(() => decideWaiver(row({ subjectEmployeeId: 'emp-1' }), def('INV-ORG-01'), u1, 'SINGLE_OPERATOR', { reason: 'مشغّل وحيد: فرق مثبت' }, now)).toThrow(HttpError);
  });

  it('INV-PAY-03 in SINGLE_OPERATOR: the owner confirmation blocks (the finding stays OPEN until confirmed)', () => {
    const d = decideExplain(row({ ruleId: 'INV-PAY-03' }), def('INV-PAY-03'), u1, 'SINGLE_OPERATOR', text, now);
    expect(d).toMatchObject({ status: 'OPEN', pendingAction: 'EXPLANATION', ownerConfirmation: 'PENDING' });
    const pending = row({ ruleId: 'INV-PAY-03', pendingAction: 'EXPLANATION', explainedById: 'u1', selfActSingleOperator: true, ownerConfirmation: 'PENDING' });
    // Nobody inside the tenant can take the owner's place.
    expect(() => decideApproveExplanation(pending, u2, now)).toThrow(/تأكيد المالك/);
    expect(decideOwnerConfirmation(pending, 'CONFIRMED', 'owner-mail-1', now)).toMatchObject({ status: 'EXPLAINED', ownerConfirmation: 'CONFIRMED' });
    expect(decideOwnerConfirmation(pending, 'REJECTED', 'owner-mail-1', now)).toMatchObject({ status: 'OPEN', ownerConfirmation: 'REJECTED', events: ['platform.discrepancy.ownerRejected'] });
    expect(() => decideOwnerConfirmation(row(), 'CONFIRMED', 'x', now)).toThrow(HttpError);
  });

  it('resolve needs a description and a reference, and not on a closed finding', () => {
    expect(decideResolve(row(), u1, { resolution: 'صُحّح فرع الموظف بقرار نقل', resolutionRef: 'TD-1' }, now)).toMatchObject({ status: 'RESOLVED' });
    expect(() => decideResolve(row({ status: 'AUTO_CLOSED' }), u1, { resolution: 'صُحّح فرع الموظف بقرار نقل', resolutionRef: 'TD-1' }, now)).toThrow(HttpError);
  });

});
