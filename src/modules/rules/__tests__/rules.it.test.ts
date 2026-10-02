// rules module against a real PostgreSQL with all migrations applied (9za_rules, 9ze_rule_override_ack).
// Opt-in: RULE_IT=1 with DATABASE_URL pointing at a THROWAWAY database (rows are not cleaned up).
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';

const RUN = process.env.RULE_IT === '1';

describe.skipIf(!RUN)('rules on PostgreSQL', { timeout: 60_000 }, async () => {
  const { prisma } = await import('@/lib/prisma');
  const {
    RULE_CATALOGUE,
    RULES_CONSUMERS,
    RULES_OVERRIDE_BELOW_LEGAL_EVENT,
    INV_RULE_02_ID,
    RuleOverrideAckRequiredError,
    RuleOverrideBoundError,
    RuleOverrideInputError,
    belowLegalOverrideCheck,
    RuleScopeError,
    catalogueLaborLaw,
    createRulesReader,
    laborLawFor,
    revokeCompanyRuleOverride,
    ruleAt,
    setCompanyRuleOverride,
    valueAt,
  } = await import('@/modules/rules');
  const { getEmployeeLeaveBalance } = await import('@/lib/hr-workflows');
  const platform = await import('@/modules/platform');

  const HR = { type: 'SYSTEM' as const, id: 'rules-it' };
  const tag = () => randomUUID().replace(/-/g, '').slice(0, 10);
  const company = (t: string) =>
    prisma.company.create({ data: { nameArabic: `قواعد ${t}`, commercialRegNum: `RULE-${t}`, commercialRegExp: new Date('2030-01-01') } });

  it('the registry holds every catalogue version after the migrations (9_workforce_engine + 9za_rules)', async () => {
    for (const d of RULE_CATALOGUE) {
      for (const v of d.versions) {
        const row = await prisma.ruleParameter.findUnique({ where: { key_effectiveFrom: { key: d.key, effectiveFrom: new Date(`${v.effectiveFrom}T00:00:00.000Z`) } } });
        expect(row?.value, `${d.key} ${v.effectiveFrom}`).toBe(v.value);
      }
    }
  });

  it('valueAt reads the registry by date; without a company override it is the legal value (parity with the catalogue)', async () => {
    expect(await valueAt('ANNUAL_LEAVE_DAYS', null, '2026-09-28')).toBe(21);
    expect(await ruleAt('PROBATION_MAX_DAYS', null, '2026-09-28')).toMatchObject({ value: 180, source: 'REGISTRY', ruleParameterId: 'rp-probation' });
    expect(await laborLawFor(prisma, null, '2026-09-28')).toEqual(catalogueLaborLaw('2026-09-28'));
  });

  it('setCompanyRuleOverride: override precedence by date, only for its company', async () => {
    const t = tag();
    const c1 = await company(`${t}a`);
    const c2 = await company(`${t}b`);
    const r = await setCompanyRuleOverride(
      prisma,
      { companyId: c1.id, key: 'ANNUAL_LEAVE_DAYS', value: 25, effectiveFrom: '2026-01-01', reason: 'سياسة الشركة', companyIds: [c1.id] },
      { key: `${t}:set`, actor: HR },
    );
    expect(r.result).toMatchObject({ mode: 'CREATED', legalValue: 21, override: { value: 25, effectiveFrom: '2026-01-01', effectiveTo: null } });
    const reader = createRulesReader(prisma);
    expect(await reader.valueAt('ANNUAL_LEAVE_DAYS', c1.id, '2026-02-01')).toBe(25);
    expect(await reader.valueAt('ANNUAL_LEAVE_DAYS', c1.id, '2025-12-31')).toBe(21);
    expect(await reader.valueAt('ANNUAL_LEAVE_DAYS', c2.id, '2026-02-01')).toBe(21);
    expect(await prisma.auditRecord.count({ where: { entityType: 'CompanyRuleOverride', entityId: r.result.override.id } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { type: 'rules.override.set', aggregateId: r.result.override.id } })).toBe(1);
  });

  it('setCompanyRuleOverride double call, one after the other, with the same operation key: one row, one audit, one event (idempotent)', async () => {
    const t = tag();
    const c = await company(t);
    const call = () =>
      setCompanyRuleOverride(
        prisma,
        { companyId: c.id, key: 'NOTICE_DAYS_EMPLOYEE', value: 45, effectiveFrom: '2026-03-01', reason: 'عقد موحد', companyIds: [c.id] },
        { key: `${t}:same`, actor: HR },
      );
    const first = await call();
    const second = await call();
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(await prisma.companyRuleOverride.count({ where: { companyId: c.id } })).toBe(1);
    expect(await prisma.auditRecord.count({ where: { entityType: 'CompanyRuleOverride', companyId: c.id } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { type: 'rules.override.set', companyId: c.id } })).toBe(1);
  });

  it('setCompanyRuleOverride concurrent double call with the same key: one row (idempotent)', async () => {
    const t = tag();
    const c = await company(t);
    const call = () =>
      setCompanyRuleOverride(
        prisma,
        { companyId: c.id, key: 'SICK_LEAVE_FULL_PAY_DAYS', value: 40, effectiveFrom: '2026-01-01', reason: 'ميزة', companyIds: 'ALL' },
        { key: `${t}:race`, actor: HR },
      );
    const [a, b] = await Promise.all([call(), call()]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await prisma.companyRuleOverride.count({ where: { companyId: c.id } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { type: 'rules.override.set', companyId: c.id } })).toBe(1);
  });

  it('setCompanyRuleOverride: a later date splits the running override; the same date updates it; same value is UNCHANGED', async () => {
    const t = tag();
    const c = await company(t);
    const set = (value: number, from: string, k: string) =>
      setCompanyRuleOverride(prisma, { companyId: c.id, key: 'ANNUAL_LEAVE_DAYS_AFTER_5Y', value, effectiveFrom: from, reason: 'تعديل', companyIds: [c.id] }, { key: `${t}:${k}`, actor: HR });
    expect((await set(32, '2026-01-01', '1')).result.mode).toBe('CREATED');
    expect((await set(35, '2026-07-01', '2')).result.mode).toBe('SPLIT');
    expect((await set(36, '2026-07-01', '3')).result.mode).toBe('UPDATED');
    expect((await set(36, '2026-07-01', '4')).result.mode).toBe('UNCHANGED');
    const rows = await prisma.companyRuleOverride.findMany({ where: { companyId: c.id }, orderBy: { effectiveFrom: 'asc' } });
    expect(rows.map((r) => [r.value, r.effectiveFrom.toISOString().slice(0, 10), r.effectiveTo?.toISOString().slice(0, 10) ?? null])).toEqual([
      [32, '2026-01-01', '2026-07-01'],
      [36, '2026-07-01', null],
    ]);
    const reader = createRulesReader(prisma);
    expect(await reader.valueAt('ANNUAL_LEAVE_DAYS_AFTER_5Y', c.id, '2026-06-30')).toBe(32);
    expect(await reader.valueAt('ANNUAL_LEAVE_DAYS_AFTER_5Y', c.id, '2026-07-01')).toBe(36);
  });

  it('setCompanyRuleOverride floor enforcement without an acknowledgement: below the legal minimum, above a maximum, a FIXED key and another company are refused, nothing written', async () => {
    const t = tag();
    const c = await company(t);
    const other = await company(`${t}x`);
    const base = { companyId: c.id, effectiveFrom: '2026-01-01', reason: 'اختبار', companyIds: [c.id] as string[] };
    await expect(setCompanyRuleOverride(prisma, { ...base, key: 'ANNUAL_LEAVE_DAYS', value: 20 }, { key: `${t}:low`, actor: HR })).rejects.toThrow(RuleOverrideBoundError);
    await expect(setCompanyRuleOverride(prisma, { ...base, key: 'NOTICE_DAYS_EMPLOYER', value: 30 }, { key: `${t}:notice`, actor: HR })).rejects.toThrow(RuleOverrideBoundError);
    await expect(setCompanyRuleOverride(prisma, { ...base, key: 'PROBATION_MAX_DAYS', value: 200 }, { key: `${t}:prob`, actor: HR })).rejects.toThrow(RuleOverrideBoundError);
    await expect(setCompanyRuleOverride(prisma, { ...base, key: 'GOSI_MAX_CONTRIBUTORY_WAGE', value: 50000 }, { key: `${t}:gosi`, actor: HR })).rejects.toThrow(RuleOverrideBoundError);
    await expect(setCompanyRuleOverride(prisma, { ...base, companyId: other.id, key: 'ANNUAL_LEAVE_DAYS', value: 25 }, { key: `${t}:scope`, actor: HR })).rejects.toThrow(RuleScopeError);
    expect(await prisma.companyRuleOverride.count({ where: { companyId: { in: [c.id, other.id] } } })).toBe(0);
    expect(await prisma.operationLog.count({ where: { operationKey: { startsWith: `${t}:` } } })).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // DEC-PO-126: below the legal minimum with a warning and a record

  const ackInput = (companyId: string, over: Record<string, unknown> = {}) => ({
    companyId,
    key: 'ANNUAL_LEAVE_DAYS',
    value: 18,
    effectiveFrom: '2026-01-01',
    reason: 'سياسة الشركة',
    companyIds: [companyId],
    acknowledgeBelowLegal: true,
    belowLegalReason: 'اتفاق مكتوب مع الموظفين',
    ...over,
  });

  it('DEC-PO-126 refused without acknowledgement: a typed error carries the legal value for the warning, nothing written', async () => {
    const t = tag();
    const c = await company(t);
    const err = await setCompanyRuleOverride(prisma, ackInput(c.id, { acknowledgeBelowLegal: undefined }), { key: `${t}:noack`, actor: HR }).catch((e) => e);
    expect(err).toBeInstanceOf(RuleOverrideAckRequiredError);
    expect(err).toMatchObject({ code: 'RULE_OVERRIDE_BELOW_LEGAL_ACK_REQUIRED', requiresAcknowledgement: true, bound: 'MIN', value: 18, legalValue: 21 });
    expect(err.messageAr).toContain('21');
    await expect(setCompanyRuleOverride(prisma, ackInput(c.id, { belowLegalReason: '  ' }), { key: `${t}:noreason`, actor: HR })).rejects.toThrow(RuleOverrideInputError);
    expect(await prisma.companyRuleOverride.count({ where: { companyId: c.id } })).toBe(0);
    expect(await prisma.domainEvent.count({ where: { companyId: c.id } })).toBe(0);
  });

  it('DEC-PO-126 accepted with acknowledgement: recorded on the row, audited, readers flag belowLegal; an unacknowledged overtaken override stays clamped', async () => {
    const t = tag();
    const c = await company(t);
    const r = await setCompanyRuleOverride(prisma, ackInput(c.id), { key: `${t}:ack`, actor: { type: 'USER', id: `user-${t}` } });
    expect(r.result).toMatchObject({ mode: 'CREATED', belowLegal: true, legalValue: 21, override: { value: 18, belowLegal: { legalValue: 21, reason: 'اتفاق مكتوب مع الموظفين', acknowledgedById: `user-${t}` } } });
    const row = await prisma.companyRuleOverride.findUniqueOrThrow({ where: { id: r.result.override.id } });
    expect(row).toMatchObject({ value: 18, belowLegalLegalValue: 21, belowLegalReason: 'اتفاق مكتوب مع الموظفين', belowLegalAckById: `user-${t}` });
    expect(row.belowLegalAckAt).toBeInstanceOf(Date);
    const audit = await prisma.auditRecord.findFirstOrThrow({ where: { entityType: 'CompanyRuleOverride', entityId: row.id } });
    expect(JSON.stringify(audit.after)).toContain('اتفاق مكتوب مع الموظفين');
    expect(await ruleAt('ANNUAL_LEAVE_DAYS', c.id, '2026-05-01', prisma)).toMatchObject({ value: 18, legalValue: 21, source: 'OVERRIDE', belowLegal: true, clamped: false });
    expect(await valueAt('ANNUAL_LEAVE_DAYS', c.id, '2026-05-01', prisma)).toBe(18);
    const warnings = await createRulesReader(prisma).belowLegal(c.id, '2026-05-01');
    expect(warnings.map((w) => [w.key, w.value, w.legalValue])).toEqual([['ANNUAL_LEAVE_DAYS', 18, 21]]);
    expect((await laborLawFor(prisma, c.id, '2026-05-01')).annualLeave.daysBeforeThreshold).toBe(18);
    // A MAX key above its ceiling is accepted the same way.
    const p = await setCompanyRuleOverride(prisma, ackInput(c.id, { key: 'PROBATION_MAX_DAYS', value: 200 }), { key: `${t}:prob`, actor: HR });
    expect(p.result).toMatchObject({ belowLegal: true, override: { belowLegal: { legalValue: 180 } } });
    expect(await ruleAt('PROBATION_MAX_DAYS', c.id, '2026-05-01', prisma)).toMatchObject({ value: 200, belowLegal: true });
    // Within the bound, the acknowledgement is ignored (nothing recorded, no warning).
    const ok = await setCompanyRuleOverride(prisma, ackInput(c.id, { key: 'NOTICE_DAYS_EMPLOYEE', value: 45 }), { key: `${t}:within`, actor: HR });
    expect(ok.result).toMatchObject({ belowLegal: false, override: { belowLegal: null } });
    expect(await prisma.domainEvent.count({ where: { type: RULES_OVERRIDE_BELOW_LEGAL_EVENT, aggregateId: ok.result.override.id } })).toBe(0);
  });

  it('DEC-PO-126: a FIXED key is refused even with an acknowledgement', async () => {
    const t = tag();
    const c = await company(t);
    const err = await setCompanyRuleOverride(prisma, ackInput(c.id, { key: 'GOSI_MAX_CONTRIBUTORY_WAGE', value: 50000 }), { key: `${t}:fixed`, actor: HR }).catch((e) => e);
    expect(err).toBeInstanceOf(RuleOverrideBoundError);
    expect(err).not.toBeInstanceOf(RuleOverrideAckRequiredError);
    expect(err.bound).toBe('FIXED');
    expect(await prisma.companyRuleOverride.count({ where: { companyId: c.id } })).toBe(0);
  });

  it('DEC-PO-126 double call with the same operation key (sequential and concurrent): one row, one audit, the belowLegal event emitted once (idempotent)', async () => {
    const t = tag();
    const c = await company(t);
    const call = (k: string) => setCompanyRuleOverride(prisma, ackInput(c.id), { key: `${t}:${k}`, actor: HR });
    const first = await call('same');
    const second = await call('same');
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual(first.result);
    const c2 = await company(`${t}c`);
    const race = () => setCompanyRuleOverride(prisma, ackInput(c2.id), { key: `${t}:race`, actor: HR });
    const [a, b] = await Promise.all([race(), race()]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    for (const id of [c.id, c2.id]) {
      expect(await prisma.companyRuleOverride.count({ where: { companyId: id } })).toBe(1);
      expect(await prisma.auditRecord.count({ where: { entityType: 'CompanyRuleOverride', companyId: id } })).toBe(1);
      expect(await prisma.domainEvent.count({ where: { type: RULES_OVERRIDE_BELOW_LEGAL_EVENT, companyId: id } })).toBe(1);
      expect(await prisma.domainEvent.count({ where: { type: 'rules.override.set', companyId: id } })).toBe(1);
    }
    // A new key with the same value and the same acknowledgement changes nothing (UNCHANGED, no new event).
    expect((await call('again')).result.mode).toBe('UNCHANGED');
    expect(await prisma.domainEvent.count({ where: { type: RULES_OVERRIDE_BELOW_LEGAL_EVENT, companyId: c.id } })).toBe(1);
  });

  it('DEC-PO-126 owner alert: the consumer queues one email to the owner contact, counts and a link only, however often it runs', async () => {
    const t = tag();
    const c = await company(t);
    const r = await setCompanyRuleOverride(prisma, ackInput(c.id), { key: `${t}:alert`, actor: HR });
    const registry = new platform.ConsumerRegistry();
    for (const k of RULES_CONSUMERS) registry.register(k);
    const before = process.env.OWNER_ALERT_EMAIL;
    process.env.OWNER_ALERT_EMAIL = `owner-${t}@example.test`;
    try {
      await platform.runConsumers({ client: prisma, registry, companyIds: null, batch: 1000 });
      await platform.runConsumers({ client: prisma, registry, companyIds: null, batch: 1000 });
    } finally {
      if (before === undefined) delete process.env.OWNER_ALERT_EMAIL;
      else process.env.OWNER_ALERT_EMAIL = before;
    }
    // Other tests' pending belowLegal events are alerted too (one row each); this override's is queued once.
    const mails = await prisma.notificationOutbox.findMany({ where: { recipient: `owner-${t}@example.test`, idempotencyKey: `rules.belowLegalOwnerAlert:${t}:alert:rules.override.belowLegal` } });
    expect(mails).toHaveLength(1);
    const all = await prisma.notificationOutbox.findMany({ where: { recipient: `owner-${t}@example.test` }, select: { idempotencyKey: true } });
    expect(new Set(all.map((m) => m.idempotencyKey)).size).toBe(all.length);
    expect(mails[0].body).toContain('21');
    expect(mails[0].body).not.toContain(c.id);
    expect(mails[0].body).not.toContain(r.result.override.id);
    expect(mails[0].body).not.toContain('اتفاق مكتوب');
  });

  it('INV-RULE-02: each active acknowledged override is an EXPLAINED, non-blocking WARNING discrepancy; revoking it auto-closes it', async () => {
    platform.registerInvariantCheck(INV_RULE_02_ID, belowLegalOverrideCheck);
    const t = tag();
    const c = await company(t);
    const r = await setCompanyRuleOverride(prisma, ackInput(c.id, { effectiveFrom: '2020-01-01' }), { key: `${t}:inv`, actor: { type: 'USER', id: `user-${t}` } });
    await platform.reconcile(prisma, { companyId: c.id, invariants: [INV_RULE_02_ID], trigger: 'MANUAL' });
    await platform.reconcile(prisma, { companyId: c.id, invariants: [INV_RULE_02_ID], trigger: 'MANUAL' });
    const rows = await prisma.discrepancy.findMany({ where: { ruleId: INV_RULE_02_ID, companyId: c.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'EXPLAINED',
      severity: 'WARNING',
      blocking: false,
      blocks: [],
      category: 'ACKNOWLEDGED_BELOW_LEGAL',
      entityType: 'CompanyRuleOverride',
      entityId: r.result.override.id,
      explanationRef: `CompanyRuleOverride:${r.result.override.id}`,
      explainedById: `user-${t}`,
      occurrences: 1,
    });
    await platform.assertNoBlockingDiscrepancies(prisma, { operation: 'payroll.approve', companyId: c.id });
    await revokeCompanyRuleOverride(prisma, { companyId: c.id, overrideId: r.result.override.id, reason: 'عودة للنظام', companyIds: [c.id] }, { key: `${t}:rev`, actor: HR });
    await platform.reconcile(prisma, { companyId: c.id, invariants: [INV_RULE_02_ID], trigger: 'MANUAL' });
    expect((await prisma.discrepancy.findFirstOrThrow({ where: { id: rows[0].id } })).status).toBe('AUTO_CLOSED');
  });

  it('revokeCompanyRuleOverride double call: the company returns to the legal value, one audit row, one event (idempotent)', async () => {
    const t = tag();
    const c = await company(t);
    const set = await setCompanyRuleOverride(
      prisma,
      { companyId: c.id, key: 'MARRIAGE_LEAVE_DAYS', value: 7, effectiveFrom: '2026-01-01', reason: 'ميزة', companyIds: [c.id] },
      { key: `${t}:set`, actor: HR },
    );
    expect(await valueAt('MARRIAGE_LEAVE_DAYS', c.id, '2026-05-01', prisma)).toBe(7);
    const revoke = () => revokeCompanyRuleOverride(prisma, { companyId: c.id, overrideId: set.result.override.id, reason: 'إلغاء', companyIds: [c.id] }, { key: `${t}:revoke`, actor: HR });
    const a = await revoke();
    const b = await revoke();
    expect(a.result.changed).toBe(true);
    expect(b.replayed).toBe(true);
    expect(await valueAt('MARRIAGE_LEAVE_DAYS', c.id, '2026-05-01', prisma)).toBe(5);
    expect(await prisma.domainEvent.count({ where: { type: 'rules.override.revoked', aggregateId: set.result.override.id } })).toBe(1);
    // A new key on a revoked override changes nothing either.
    const again = await revokeCompanyRuleOverride(prisma, { companyId: c.id, overrideId: set.result.override.id, reason: 'إلغاء', companyIds: [c.id] }, { key: `${t}:revoke2`, actor: HR });
    expect(again.result.changed).toBe(false);
    await expect(
      revokeCompanyRuleOverride(prisma, { companyId: c.id, overrideId: set.result.override.id, reason: 'x', companyIds: ['other'] }, { key: `${t}:revoke3`, actor: HR }),
    ).rejects.toThrow(RuleScopeError);
  });

  it('call site: the leave balance uses the company override (getEmployeeLeaveBalance), the legal value without one', async () => {
    const t = tag();
    const c = await company(t);
    const emp = await prisma.employee.create({
      data: {
        employeeId: `RULE-${t}`, firstNameArabic: 'موظف', lastNameArabic: t, nationality: 'SA', iqamaOrIdNumber: `RULE${t}`,
        iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'M', joinDate: new Date('2025-01-01'),
        basicSalary: 5000, legalCompanyId: c.id,
      },
    });
    const asOf = new Date('2026-01-01');
    expect((await getEmployeeLeaveBalance(prisma, emp.id, { asOf })).accrued).toBe(21);
    await setCompanyRuleOverride(
      prisma,
      { companyId: c.id, key: 'ANNUAL_LEAVE_DAYS', value: 25, effectiveFrom: '2025-01-01', reason: 'سياسة', companyIds: [c.id] },
      { key: `${t}:set`, actor: HR },
    );
    expect((await getEmployeeLeaveBalance(prisma, emp.id, { asOf })).accrued).toBe(25);
  });
});
