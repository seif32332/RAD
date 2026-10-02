// org.applyAssignment against a real PostgreSQL with all migrations applied (9u_effective_periods).
// Opt-in: EFF_IT=1 with DATABASE_URL pointing at a THROWAWAY database (rows are not cleaned up).
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import { todayKey } from '@/lib/dates';

const RUN = process.env.EFF_IT === '1';

describe.skipIf(!RUN)('org.applyAssignment on PostgreSQL', { timeout: 60_000 }, async () => {
  const { prisma } = await import('@/lib/prisma');
  const { applyAssignment, assignmentAt, AssignmentPlacementError, AssignmentScopeError, AssignmentScheduleError } = await import('@/modules/org');
  const { lineageOf } = await import('@/modules/platform');

  const HR = { type: 'SYSTEM' as const, id: 'org-it' };
  const tag = () => randomUUID().replace(/-/g, '').slice(0, 10);

  async function org(t: string) {
    const c1 = await prisma.company.create({ data: { nameArabic: `أ ${t}`, commercialRegNum: `ORG-${t}-1`, commercialRegExp: new Date('2030-01-01') } });
    const c2 = await prisma.company.create({ data: { nameArabic: `ب ${t}`, commercialRegNum: `ORG-${t}-2`, commercialRegExp: new Date('2030-01-01') } });
    const b1 = await prisma.branch.create({ data: { companyId: c1.id, nameArabic: `فرع ${t}` } });
    const b2 = await prisma.branch.create({ data: { companyId: c2.id, nameArabic: `فرع ${t} ب` } });
    const d1 = await prisma.department.create({ data: { branchId: b1.id, nameArabic: `قسم ${t}` } });
    return { c1, c2, b1, b2, d1 };
  }
  async function employee(t: string, legalCompanyId: string) {
    return prisma.employee.create({
      data: {
        employeeId: `ORG-${t}`, firstNameArabic: 'موظف', lastNameArabic: t, nationality: 'SA', iqamaOrIdNumber: `ORG${t}`,
        iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'M', joinDate: new Date('2024-01-01'),
        basicSalary: 5000, legalCompanyId,
      },
    });
  }
  const src = (id: string) => ({ type: 'TRANSFER_DECISION', id });

  it('applyAssignment opens the first assignment and projects it onto Employee when in force today', async () => {
    const t = tag();
    const o = await org(t);
    const e = await employee(t, o.c1.id);
    const r = await applyAssignment(prisma, {
      employeeId: e.id, validFrom: '2024-01-01', companyIds: [o.c1.id], source: src(t),
      assignment: { legalCompanyId: o.c1.id, actualCompanyId: o.c1.id, branchId: o.b1.id, departmentId: o.d1.id },
    }, { key: `${t}:1`, actor: HR });
    expect(r.replayed).toBe(false);
    expect(r.result).toMatchObject({ changed: true, mode: 'OPENED', projected: true, period: { validFrom: '2024-01-01', validTo: null } });
    const emp = await prisma.employee.findUniqueOrThrow({ where: { id: e.id } });
    expect([emp.legalCompanyId, emp.actualCompanyId, emp.branchId, emp.departmentId]).toEqual([o.c1.id, o.c1.id, o.b1.id, o.d1.id]);
    expect(await prisma.domainEvent.count({ where: { type: 'assignment.periodOpened', aggregateId: r.result.period.lineageId } })).toBe(1);
  });

  it('applyAssignment double call, one after the other, with the same operation key: one period, same result (idempotent)', async () => {
    const t = tag();
    const o = await org(t);
    const e = await employee(t, o.c1.id);
    const call = () => applyAssignment(prisma, {
      employeeId: e.id, validFrom: '2024-01-01', companyIds: [o.c1.id], source: src(t), assignment: { legalCompanyId: o.c1.id, branchId: o.b1.id },
    }, { key: `${t}:same`, actor: HR });
    const first = await call();
    const second = await call();
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(await prisma.assignmentPeriod.count({ where: { employeeId: e.id } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { type: 'assignment.periodOpened', aggregateId: first.result.period.lineageId } })).toBe(1);
    expect(await prisma.operationLog.count({ where: { operationKey: `${t}:same` } })).toBe(1);
  });

  it('applyAssignment double call, concurrently, with the same operation key: one period, both callers get the same result', async () => {
    const t = tag();
    const o = await org(t);
    const e = await employee(t, o.c1.id);
    const call = () => applyAssignment(prisma, {
      employeeId: e.id, validFrom: '2024-01-01', companyIds: [o.c1.id], source: src(t), assignment: { legalCompanyId: o.c1.id },
    }, { key: `${t}:race`, actor: HR });
    const results = await Promise.all([call(), call()]);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results[0].result).toEqual(results[1].result);
    expect(await prisma.assignmentPeriod.count({ where: { employeeId: e.id } })).toBe(1);
  });

  it('applyAssignment with a new operation key but the same assignment changes nothing', async () => {
    const t = tag();
    const o = await org(t);
    const e = await employee(t, o.c1.id);
    const input = { employeeId: e.id, validFrom: '2024-01-01', companyIds: [o.c1.id], source: src(t), assignment: { legalCompanyId: o.c1.id } };
    await applyAssignment(prisma, input, { key: `${t}:a`, actor: HR });
    const again = await applyAssignment(prisma, { ...input, validFrom: '2025-01-01' }, { key: `${t}:b`, actor: HR });
    expect(again.result).toMatchObject({ changed: false, mode: 'UNCHANGED' });
    expect(await prisma.assignmentPeriod.count({ where: { employeeId: e.id } })).toBe(1);
  });

  it('applyAssignment from a later day splits: the running period ends there (same lineage), the new one starts', async () => {
    const t = tag();
    const o = await org(t);
    const e = await employee(t, o.c1.id);
    const first = await applyAssignment(prisma, {
      employeeId: e.id, validFrom: '2024-01-01', companyIds: 'ALL', source: src(`${t}a`), assignment: { legalCompanyId: o.c1.id, branchId: o.b1.id },
    }, { key: `${t}:a`, actor: HR });
    const moved = await applyAssignment(prisma, {
      employeeId: e.id, validFrom: '2025-03-01', companyIds: [o.c1.id, o.c2.id], source: src(`${t}b`), assignment: { legalCompanyId: o.c2.id, branchId: o.b2.id },
    }, { key: `${t}:b`, actor: HR });
    expect(moved.result.mode).toBe('SPLIT');
    const before = await assignmentAt(prisma, e.id, '2025-02-28');
    const after = await assignmentAt(prisma, e.id, '2025-03-01');
    expect(before).toMatchObject({ lineageId: first.result.period.lineageId, validTo: '2025-03-01', attrs: { legalCompanyId: o.c1.id } });
    expect(after).toMatchObject({ validFrom: '2025-03-01', validTo: null, attrs: { legalCompanyId: o.c2.id, branchId: o.b2.id } });
    expect(after?.lineageId).not.toBe(first.result.period.lineageId);
    const chain = await lineageOf(prisma, 'ASSIGNMENT', first.result.period.lineageId);
    expect(chain.map((p) => p.supersedeReason)).toEqual(['CLOSE', null]);
  });

  it('applyAssignment on the same first day is a correction of that period (supersede, same lineage)', async () => {
    const t = tag();
    const o = await org(t);
    const e = await employee(t, o.c1.id);
    const first = await applyAssignment(prisma, { employeeId: e.id, validFrom: '2024-01-01', companyIds: [o.c1.id], source: src(`${t}a`), assignment: { legalCompanyId: o.c1.id } }, { key: `${t}:a`, actor: HR });
    const fixed = await applyAssignment(prisma, {
      employeeId: e.id, validFrom: '2024-01-01', companyIds: [o.c1.id], source: src(`${t}b`), assignment: { legalCompanyId: o.c1.id, branchId: o.b1.id, departmentId: o.d1.id },
    }, { key: `${t}:b`, actor: HR });
    expect(fixed.result.mode).toBe('CORRECTION');
    expect(fixed.result.period.lineageId).toBe(first.result.period.lineageId);
    expect(fixed.result.period.supersedesId).toBe(first.result.period.id);
  });

  it('applyAssignment enforces INV-ORG-01 placement and the company scope of both companies', async () => {
    const t = tag();
    const o = await org(t);
    const e = await employee(t, o.c1.id);
    const base = { employeeId: e.id, validFrom: '2024-01-01', source: src(t) };
    await expect(applyAssignment(prisma, { ...base, companyIds: 'ALL', assignment: { legalCompanyId: o.c1.id, branchId: o.b2.id } }, { key: `${t}:p1`, actor: HR })).rejects.toThrow(AssignmentPlacementError);
    await expect(applyAssignment(prisma, { ...base, companyIds: 'ALL', assignment: { legalCompanyId: o.c2.id, actualCompanyId: o.c2.id, branchId: o.b2.id, departmentId: o.d1.id } }, { key: `${t}:p2`, actor: HR })).rejects.toThrow(/INV-ORG-01/);
    // Allowed: a legal company c1 employee working in c2's branch, declared through the actual company.
    await applyAssignment(prisma, { ...base, companyIds: [o.c1.id, o.c2.id], assignment: { legalCompanyId: o.c1.id, actualCompanyId: o.c2.id, branchId: o.b2.id } }, { key: `${t}:ok`, actor: HR });
    // Deny: another company's caller; a transfer to c2 by a caller who only has c1.
    await expect(applyAssignment(prisma, { ...base, validFrom: '2025-01-01', companyIds: [o.c2.id], assignment: { legalCompanyId: o.c2.id } }, { key: `${t}:d1`, actor: HR })).rejects.toThrow(AssignmentScopeError);
    await expect(applyAssignment(prisma, { ...base, validFrom: '2025-01-01', companyIds: [o.c1.id], assignment: { legalCompanyId: o.c2.id } }, { key: `${t}:d2`, actor: HR })).rejects.toThrow(AssignmentScopeError);
    expect(await prisma.assignmentPeriod.count({ where: { employeeId: e.id } })).toBe(1);
  });

  it('applyAssignment refuses to insert before an already scheduled later assignment (chains are P3-ORG)', async () => {
    const t = tag();
    const o = await org(t);
    const e = await employee(t, o.c1.id);
    await applyAssignment(prisma, { employeeId: e.id, validFrom: '2030-01-01', companyIds: 'ALL', source: src(`${t}a`), assignment: { legalCompanyId: o.c1.id } }, { key: `${t}:a`, actor: HR });
    await expect(
      applyAssignment(prisma, { employeeId: e.id, validFrom: '2029-01-01', companyIds: 'ALL', source: src(`${t}b`), assignment: { legalCompanyId: o.c2.id } }, { key: `${t}:b`, actor: HR }),
    ).rejects.toThrow(AssignmentScheduleError);
    // A future-dated assignment is not projected onto Employee before it starts.
    const emp = await prisma.employee.findUniqueOrThrow({ where: { id: e.id } });
    expect(todayKey() < '2030-01-01' ? emp.branchId : null).toBeNull();
  });
});
