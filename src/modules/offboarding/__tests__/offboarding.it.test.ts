// offboarding.projectExitReason and its employment.* consumer against a real PostgreSQL (LCY_IT=1,
// THROWAWAY database). The exit-reason projection always converges on the latest state fact; the
// settlement effect log (SettlementEffect) is append-only and written once per effect.
import { randomUUID } from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { moneyFixture } from '@/test/money-fixtures';
import { employeeFixture } from '@/test/money-fixtures';

const RUN = process.env.LCY_IT === '1';

describe.skipIf(!RUN)('offboarding exit-reason projection (P1-LCY)', { timeout: 60_000 }, async () => {
  const { prisma } = await import('@/lib/prisma');
  const { runEmploymentTransition } = await import('@/modules/lifecycle');
  const { projectExitReason, exitReasonProjection, recordSettlementEffects, settlementEffects } = await import('@/modules/offboarding');
  const { ConsumerRegistry, runConsumers } = await import('@/modules/platform');

  const t = randomUUID().replace(/-/g, '').slice(0, 10);
  let co = '';
  let hr = '';
  beforeAll(async () => {
    co = (await prisma.company.create({ data: { nameArabic: `OFF ${t}`, commercialRegNum: `OFF-${t}`, commercialRegExp: new Date('2030-01-01') } })).id;
    hr = (await prisma.user.create({ data: { email: `off-${t}@example.test`, passwordHash: 'x', role: 'HR_MANAGER' } })).id;
  });
  let n = 0;
  const employee = () =>
    employeeFixture({
        employeeId: `OFF-${t}-${++n}`, firstNameArabic: 'م', lastNameArabic: 'ع', nationality: 'SA', iqamaOrIdNumber: `OFF${t}${n}`,
        iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'M', joinDate: new Date('2024-01-01'), basicSalary: 5000, legalCompanyId: co,
      });
  const exit = (employeeId: string) =>
    runEmploymentTransition(prisma, {
      employeeId, command: 'EXIT', date: '2026-09-01', exitReason: 'RESIGNATION', exitVoluntary: true,
      source: { type: 'TEST', id: employeeId }, actor: { type: 'USER', id: hr }, operationKey: `off:${randomUUID()}`, companyIds: [co],
    });
  const actor = { type: 'SYSTEM' as const, id: 'test' };

  it('projectExitReason double call (sequential and concurrent): the projection equals the latest fact, one audit row (idempotent)', async () => {
    const e = await employee();
    await exit(e.id);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.id } })).exitReason).toBeNull();
    const key = `off:${randomUUID()}`;
    const [a, b] = await Promise.all([
      prisma.$transaction((tx) => projectExitReason(tx, e.id, { key, actor })).catch(() => null),
      prisma.$transaction((tx) => projectExitReason(tx, e.id, { key, actor })).catch(() => null),
    ]);
    const ok = a ?? b;
    expect(ok).toMatchObject({ exitReason: 'RESIGNATION', exitVoluntary: true });
    const again = await prisma.$transaction((tx) => projectExitReason(tx, e.id, { key, actor }));
    expect(again).toMatchObject({ changed: true, exitReason: 'RESIGNATION' });
    const other = await prisma.$transaction((tx) => projectExitReason(tx, e.id, { key: `off:${randomUUID()}`, actor }));
    expect(other.changed).toBe(false);
    const x = await prisma.employee.findUniqueOrThrow({ where: { id: e.id } });
    expect([x.exitReason, x.exitVoluntary]).toEqual(['RESIGNATION', true]);
    expect(await prisma.auditRecord.count({ where: { action: 'offboarding.exitReason.project', entityId: e.id } })).toBe(1);
  });

  it('the consumer of employment.* projects the reason once, and a replayed run changes nothing', async () => {
    const e = await employee();
    await exit(e.id);
    const registry = new ConsumerRegistry();
    registry.register(exitReasonProjection);
    await runConsumers({ client: prisma, registry, companyIds: [co], batch: 1000 });
    await runConsumers({ client: prisma, registry, companyIds: [co], batch: 1000 });
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.id } })).exitReason).toBe('RESIGNATION');
    const ev = await prisma.domainEvent.findFirstOrThrow({ where: { aggregateId: e.id, type: 'employment.terminated' } });
    expect(await prisma.eventConsumption.count({ where: { eventId: ev.id, consumer: exitReasonProjection.name, status: 'DONE' } })).toBe(1);
  });

  describe('recordSettlementEffects (SettlementEffect, DEC-PO-128)', () => {
    const settlement = async () => {
      const e = await employee();
      return moneyFixture((tx) => tx.settlement.create({ data: { employeeId: e.id, type: 'END_OF_SERVICE', totalSettlement: 100, status: 'OWNER_APPROVED' } }));
    };
    const effects = (employeeId: string) => [
      { kind: 'LOAN' as const, refId: `loan-${t}-1`, before: { remainingAmount: 500, status: 'ACTIVE', isForgiven: false }, after: { remainingAmount: 0, status: 'PAID', isForgiven: false } },
      { kind: 'LEAVE_ACCRUAL' as const, refId: employeeId, before: { leaveAccrualStartDate: '2024-01-01' }, after: { leaveAccrualStartDate: '2026-09-02' } },
      { kind: 'LOGIN' as const, refId: employeeId, before: { isActive: true, documentsOnlyUntil: null }, after: null },
    ];

    it('recordSettlementEffects double call (sequential, then concurrent): the log has each effect once (idempotent)', async () => {
      const s = await settlement();
      const first = await prisma.$transaction((tx) => recordSettlementEffects(tx, { settlementId: s.id, effects: effects(s.employeeId) }));
      expect(first).toEqual({ settlementId: s.id, recorded: 3, existing: 0 });
      const again = await prisma.$transaction((tx) => recordSettlementEffects(tx, { settlementId: s.id, effects: effects(s.employeeId) }));
      expect(again).toEqual({ settlementId: s.id, recorded: 0, existing: 3 });
      const rows = await settlementEffects(prisma, s.id);
      expect(rows).toHaveLength(3);
      expect(rows.find((r) => r.kind === 'LOGIN')).toMatchObject({ employeeId: s.employeeId, after: null });

      const s2 = await settlement();
      const both = await Promise.all([0, 1].map(() => prisma.$transaction((tx) => recordSettlementEffects(tx, { settlementId: s2.id, effects: effects(s2.employeeId) }))));
      expect(both.map((r) => r.recorded).sort()).toEqual([0, 3]);
      expect(await prisma.settlementEffect.count({ where: { settlementId: s2.id } })).toBe(3);
    });

    it('recordSettlementEffects refuses unknown kinds, missing references, duplicates and the root client', async () => {
      const s = await settlement();
      await expect(prisma.$transaction((tx) => recordSettlementEffects(tx, { settlementId: s.id, effects: [{ kind: 'X' as never, refId: 'a', before: null, after: null }] }))).rejects.toThrow(/unknown effect kind/);
      await expect(prisma.$transaction((tx) => recordSettlementEffects(tx, { settlementId: s.id, effects: [{ kind: 'LOAN', refId: ' ', before: null, after: null }] }))).rejects.toThrow(/without a reference/);
      const dup = { kind: 'LOAN' as const, refId: 'x', before: null, after: null };
      await expect(prisma.$transaction((tx) => recordSettlementEffects(tx, { settlementId: s.id, effects: [dup, dup] }))).rejects.toThrow(/twice/);
      await expect(recordSettlementEffects(prisma as never, { settlementId: s.id, effects: [] })).rejects.toThrow(/transaction/);
      expect(await prisma.settlementEffect.count({ where: { settlementId: s.id } })).toBe(0);
    });

    it('SettlementEffect is append-only (trigger): update, delete and a kind outside the CHECK are refused', async () => {
      const s = await settlement();
      await prisma.$transaction((tx) => recordSettlementEffects(tx, { settlementId: s.id, effects: effects(s.employeeId) }));
      const [row] = await settlementEffects(prisma, s.id);
      await expect(prisma.settlementEffect.update({ where: { id: row.id }, data: { after: {} } })).rejects.toThrow(/append-only/);
      await expect(prisma.settlementEffect.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
      await expect(prisma.settlementEffect.create({ data: { settlementId: s.id, employeeId: s.employeeId, kind: 'OTHER', refId: 'x' } })).rejects.toThrow(/kind_check/);
    });
  });
});
