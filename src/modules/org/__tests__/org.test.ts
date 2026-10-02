// org unit tests: applyAssignment input validation (before any database access). The database
// behaviour, including the double-call (idempotency) tests, is org.it.test.ts.
import { describe, expect, it } from 'vitest';
import { applyAssignment, AssignmentPlacementError, AssignmentScopeError } from '@/modules/org';

const noDb = {} as never;
const op = { key: 'k', actor: { type: 'SYSTEM' as const, id: 'unit' } };
const base = { employeeId: 'e1', validFrom: '2026-10-01', source: { type: 'TRANSFER_DECISION', id: 't1' }, companyIds: null };

describe('applyAssignment input', () => {
  it('needs the employee and the legal company', async () => {
    await expect(applyAssignment(noDb, { ...base, employeeId: '', assignment: { legalCompanyId: 'c1' } }, op)).rejects.toThrow(AssignmentPlacementError);
    await expect(applyAssignment(noDb, { ...base, assignment: { legalCompanyId: ' ' } }, op)).rejects.toThrow(/legalCompanyId/);
  });

  it('has no default company scope', async () => {
    const { companyIds: _omit, ...noScope } = base;
    await expect(applyAssignment(noDb, { ...noScope, assignment: { legalCompanyId: 'c1' } } as never, op)).rejects.toThrow(AssignmentScopeError);
  });

  it('takes date-only values', async () => {
    await expect(applyAssignment(noDb, { ...base, validFrom: new Date('2026-09-30T21:00:00Z'), assignment: { legalCompanyId: 'c1' } }, op)).rejects.toThrow(/date-only/);
  });
});
