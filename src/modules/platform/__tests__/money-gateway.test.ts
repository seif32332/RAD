// money.gateway without a database (BL-PAY-001 acceptance: "pure-rule tests cover every act × role,
// including SUPER_ADMIN, allow_self_approval=true and SINGLE_OPERATOR"; BL-PAY-002: the write analysis
// the Prisma extension relies on). The DB-backed proof is money-gateway.it.test.ts (PAY_IT).
import { describe, expect, it } from 'vitest';
import {
  BENEFICIARY_ACTS,
  MONEY_ACTS,
  MONEY_TABLES,
  MoneyGatewayViolationError,
  PAYER_ACTS,
  assertWriteAllowed,
  buildRelations,
  decideMakerChecker,
  decideReversal,
  decideSelfDealing,
  defineMoneyOperation,
  isDataModifyingSql,
  moneyActorOf,
  moneyOperation,
  protectedPart,
  rawSqlText,
  rawWrites,
  runMoneyOperation,
  writesOf,
  MONEY_COLUMNS,
} from '@/modules/platform';

const ROLES = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'HR_MANAGER', 'FINANCE_MANAGER', 'PAYROLL_ADMIN', 'BRANCH_MANAGER', 'EMPLOYEE'];
const me = { userId: 'u1', employeeId: 'e1' };

describe('decideSelfDealing (BR-PAY-001 / BR-PAY-002): every act × role, both operator modes', () => {
  it('no role and no setting is an exception: the beneficiary is refused for every beneficiary act (ENFORCED)', () => {
    for (const role of ROLES) {
      for (const act of MONEY_ACTS) {
        const d = decideSelfDealing({ act, actor: me, beneficiaries: ['e1'], mode: 'ENFORCED' });
        const expected = BENEFICIARY_ACTS.includes(act);
        expect(d.ok, `${role} ${act}`).toBe(!expected);
        if (expected) expect(d.reasons).toEqual(['SELF_BENEFICIARY']);
      }
    }
  });

  it('a request for oneself is allowed (DEC-PO-006); someone else\'s money is allowed', () => {
    expect(decideSelfDealing({ act: 'REQUEST', actor: me, beneficiaries: ['e1'], mode: 'ENFORCED' }).ok).toBe(true);
    for (const act of MONEY_ACTS) expect(decideSelfDealing({ act, actor: me, beneficiaries: ['e2'], approvers: ['u2'], mode: 'ENFORCED' }).ok).toBe(true);
  });

  it('the payer / transferrer / exporter is never an approver (BR-PAY-002), whatever the role', () => {
    for (const act of MONEY_ACTS) {
      const d = decideSelfDealing({ act, actor: me, beneficiaries: [], approvers: ['u1'], mode: 'ENFORCED' });
      expect(d.ok, act).toBe(!PAYER_ACTS.includes(act));
    }
  });

  it('DEC-PO-015: an operation may turn the beneficiary rule off (payroll line payment) but keeps the approver rule', () => {
    expect(decideSelfDealing({ act: 'PAY', actor: me, beneficiaries: ['e1'], notBeneficiary: false, mode: 'ENFORCED' }).ok).toBe(true);
    expect(decideSelfDealing({ act: 'PAY', actor: me, beneficiaries: ['e1'], approvers: ['u1'], notBeneficiary: false, mode: 'ENFORCED' }).reasons).toEqual(['PAYER_IS_APPROVER']);
  });

  it('SINGLE_OPERATOR (DEC-PO-018, BR-PAY-020): nothing is refused, every breaking act is a recorded self-act', () => {
    for (const act of MONEY_ACTS) {
      const d = decideSelfDealing({ act, actor: me, beneficiaries: ['e1'], approvers: ['u1'], mode: 'SINGLE_OPERATOR' });
      expect(d.ok).toBe(true);
      expect(d.selfAct).toBe(d.reasons.length > 0);
    }
    expect(decideSelfDealing({ act: 'APPROVE', actor: me, beneficiaries: ['e2'], mode: 'SINGLE_OPERATOR' }).selfAct).toBe(false);
  });

  it('an actor without an employee file is never a beneficiary', () => {
    expect(decideSelfDealing({ act: 'APPROVE', actor: { userId: 'u1', employeeId: null }, beneficiaries: [null, undefined], mode: 'ENFORCED' }).ok).toBe(true);
  });
});

describe('decideMakerChecker and decideReversal', () => {
  it('APPROVE: not the requester; PAY: neither requester nor approver, and something recorded (BR-PAY-015)', () => {
    const a = { userId: 'u1', employeeId: null };
    expect(decideMakerChecker({ step: 'APPROVE', actor: a, requestedById: 'u1', mode: 'ENFORCED' }).reasons).toEqual(['SAME_PERSON_TWICE']);
    expect(decideMakerChecker({ step: 'APPROVE', actor: a, requestedById: null, mode: 'ENFORCED' }).ok).toBe(true);
    expect(decideMakerChecker({ step: 'PAY', actor: a, requestedById: null, approvedById: null, mode: 'ENFORCED' }).reasons).toEqual(['UNKNOWN_APPROVER']);
    expect(decideMakerChecker({ step: 'PAY', actor: a, requestedById: 'u2', approvedById: 'u1', mode: 'ENFORCED' }).reasons).toEqual(['PAYER_IS_APPROVER']);
    expect(decideMakerChecker({ step: 'PAY', actor: a, requestedById: 'u2', approvedById: 'u3', mode: 'ENFORCED' }).ok).toBe(true);
    expect(decideMakerChecker({ step: 'PAY', actor: a, requestedById: 'u1', approvedById: 'u3', mode: 'SINGLE_OPERATOR' })).toMatchObject({ ok: true, selfAct: true });
  });

  it('reverseMoney core: two different people, neither a beneficiary (§18)', () => {
    const r = (req: string, reqE: string | null, appr: string, apprE: string | null, mode: 'ENFORCED' | 'SINGLE_OPERATOR' = 'ENFORCED') =>
      decideReversal({ requestedBy: { userId: req, employeeId: reqE }, approver: { userId: appr, employeeId: apprE }, beneficiaries: ['e9'], mode });
    expect(r('u1', null, 'u2', null).ok).toBe(true);
    expect(r('u1', null, 'u1', null).reasons).toEqual(['SAME_PERSON_TWICE']);
    expect(r('u1', 'e9', 'u2', null).reasons).toEqual(['SELF_BENEFICIARY']);
    expect(r('u1', null, 'u2', 'e9').reasons).toEqual(['SELF_BENEFICIARY']);
    expect(r('u1', null, 'u1', null, 'SINGLE_OPERATOR')).toMatchObject({ ok: true, selfAct: true });
  });
});

describe('writesOf: every write shape, recursively over the relations (BR-PAY-018, RT-PAY-401)', () => {
  it('top-level operations', () => {
    expect(writesOf('Loan', 'findMany', {})).toEqual([]);
    expect(writesOf('Loan', 'create', { data: { amount: 1 } })).toEqual([{ model: 'Loan', columns: ['amount'], kind: 'create' }]);
    expect(writesOf('Loan', 'createMany', { data: [{ amount: 1 }, { status: 'X' }] }).map((t) => t.columns)).toEqual([['amount'], ['status']]);
    expect(writesOf('Loan', 'createManyAndReturn', { data: [{ amount: 1 }] })[0].model).toBe('Loan');
    expect(writesOf('Loan', 'updateMany', { where: {}, data: { status: 'X' } })).toEqual([{ model: 'Loan', columns: ['status'], kind: 'update' }]);
    expect(writesOf('Loan', 'upsert', { where: { id: 'x' }, create: { amount: 1 }, update: { status: 'x' } }).map((t) => t.kind)).toEqual(['create', 'update']);
    expect(writesOf('Loan', 'delete', { where: { id: 'x' } })).toEqual([{ model: 'Loan', columns: '*', kind: 'delete' }]);
    expect(writesOf('Loan', 'deleteMany', {})).toEqual([{ model: 'Loan', columns: '*', kind: 'delete' }]);
  });

  it('nested writes from another model: create, createMany, update(Many), upsert, delete(Many), connect / set', () => {
    const touched = (args: unknown) => writesOf('Employee', 'update', args).filter((t) => t.model !== 'Employee');
    expect(touched({ where: { id: 'e' }, data: { allowances: { create: [{ name: 'x', amount: 1 }] } } })[0]).toMatchObject({ model: 'Allowance', kind: 'create' });
    expect(touched({ where: { id: 'e' }, data: { loans: { createMany: { data: [{ amount: 1 }] } } } })[0]).toMatchObject({ model: 'Loan', kind: 'create' });
    expect(touched({ where: { id: 'e' }, data: { loans: { updateMany: { where: {}, data: { status: 'X' } } } } })[0]).toMatchObject({ model: 'Loan', columns: ['status'] });
    expect(touched({ where: { id: 'e' }, data: { loans: { upsert: [{ where: { id: 'l' }, create: { amount: 1 }, update: { amount: 2 } }] } } }).length).toBe(2);
    expect(touched({ where: { id: 'e' }, data: { payrolls: { deleteMany: {} } } })[0]).toMatchObject({ model: 'Payroll', columns: '*', kind: 'delete' });
    expect(touched({ where: { id: 'e' }, data: { loans: { connect: { id: 'l' } } } })[0]).toMatchObject({ model: 'Loan', columns: ['employeeId'] });
    // A many-to-one relation written from the row = its own FK column.
    expect(writesOf('Loan', 'create', { data: { employee: { connect: { id: 'e' } }, amount: 1 } })[0].columns).toEqual(expect.arrayContaining(['employeeId', 'amount']));
  });

  it('buildRelations resolves the FK side of a one-to-one / one-to-many connect (User.employeeProfile → Employee.userId)', () => {
    const t = writesOf('User', 'create', { data: { email: 'x', employeeProfile: { connect: { id: 'e1' } } } });
    expect(t.find((x) => x.model === 'Employee')).toMatchObject({ columns: ['userId'], kind: 'update' });
    const rel = buildRelations([
      { name: 'A', fields: [{ name: 'bs', kind: 'object', type: 'B', relationName: 'AB', relationFromFields: [] }] },
      { name: 'B', fields: [{ name: 'a', kind: 'object', type: 'A', relationName: 'AB', relationFromFields: ['aId'] }] },
    ]);
    expect(rel.get('A')?.get('bs')).toEqual({ model: 'B', fromFields: [], targetFromFields: ['aId'] });
  });
});

describe('protectedPart and assertWriteAllowed (fail closed outside a gateway context)', () => {
  it('money tables always; Employee money columns on create (P1-PAY-B) and update; OvertimeRequest links always; Employee delete', () => {
    expect(protectedPart({ model: 'Payroll', columns: ['status'], kind: 'update' })).not.toBeNull();
    expect(protectedPart({ model: 'Employee', columns: ['basicSalary', 'firstNameArabic'], kind: 'create' })?.columns).toEqual(['basicSalary']);
    expect(protectedPart({ model: 'Employee', columns: ['firstNameArabic'], kind: 'create' })).toBeNull();
    expect(protectedPart({ model: 'Employee', columns: ['basicSalary', 'jobTitle'], kind: 'update' })?.columns).toEqual(['basicSalary']);
    expect(protectedPart({ model: 'Employee', columns: ['jobTitle'], kind: 'update' })).toBeNull();
    expect(protectedPart({ model: 'Employee', columns: '*', kind: 'delete' })).not.toBeNull();
    expect(protectedPart({ model: 'OvertimeRequest', columns: ['paidInPayrollId'], kind: 'create' })).not.toBeNull();
    expect(protectedPart({ model: 'OvertimeRequest', columns: ['status'], kind: 'update' })).toBeNull();
    expect(protectedPart({ model: 'Leave', columns: '*', kind: 'delete' })).toBeNull();
  });

  it('refuses every money table outside a context; lets reads and non-money writes through', () => {
    for (const t of MONEY_TABLES) {
      expect(() => assertWriteAllowed(t, 'create', { data: {} }), t).toThrow(MoneyGatewayViolationError);
      expect(() => assertWriteAllowed(t, 'deleteMany', {}), t).toThrow(MoneyGatewayViolationError);
      expect(() => assertWriteAllowed(t, 'findMany', {})).not.toThrow();
    }
    expect(() => assertWriteAllowed('Leave', 'update', { data: { status: 'X' } })).not.toThrow();
    for (const c of MONEY_COLUMNS.Employee.columns) expect(() => assertWriteAllowed('Employee', 'updateMany', { data: { [c]: null } }), c).toThrow(MoneyGatewayViolationError);
  });

  it('raw SQL: DML naming a money table is refused; reads and row locks pass; unreadable text is refused', () => {
    expect(isDataModifyingSql('SELECT * FROM "Loan" FOR UPDATE')).toBe(false);
    expect(isDataModifyingSql(`SELECT 'UPDATE "Loan"' AS x -- DELETE`)).toBe(false);
    expect(isDataModifyingSql('WITH x AS (UPDATE "Loan" SET a=1 RETURNING id) SELECT 1')).toBe(true);
    expect(rawWrites('UPDATE "LoanInstallment" SET amount = 0', MONEY_TABLES, MONEY_COLUMNS).map((t) => t.model)).toEqual(['LoanInstallment']);
    expect(rawWrites('UPDATE "Employee" SET "jobTitle" = $1', MONEY_TABLES, MONEY_COLUMNS)).toEqual([]);
    expect(rawWrites('UPDATE "Employee" SET "ibanNumber" = $1', MONEY_TABLES, MONEY_COLUMNS)[0]).toMatchObject({ model: 'Employee', columns: ['ibanNumber'] });
    expect(rawWrites(null, MONEY_TABLES, MONEY_COLUMNS).length).toBe(MONEY_TABLES.length);
    expect(rawSqlText('$executeRawUnsafe', ['DELETE FROM "Loan"'])).toBe('DELETE FROM "Loan"');
    expect(rawSqlText('$executeRaw', { strings: ['DELETE FROM "Payroll" WHERE id = ', ''], values: [1] })).toContain('"Payroll"');
    expect(() => assertWriteAllowed(undefined, '$executeRawUnsafe', ['TRUNCATE "Settlement"'])).toThrow(MoneyGatewayViolationError);
    expect(() => assertWriteAllowed(undefined, '$queryRawUnsafe', ['SELECT count(*) FROM "Payroll"'])).not.toThrow();
  });
});

describe('the operation registry', () => {
  it('names, acts and writes are validated; a name is registered once; only registered operations run', async () => {
    expect(() => defineMoneyOperation({ name: 'Bad Name', owner: 'x', act: 'PAY', source: 'USER', writes: { Loan: '*' } })).toThrow(/invalid operation name/);
    expect(() => defineMoneyOperation({ name: 'unit.op.noWrites', owner: 'x', act: 'PAY', source: 'USER', writes: {} })).toThrow(/writes nothing/);
    expect(() => defineMoneyOperation({ name: 'unit.op.badAct', owner: 'x', act: 'STEAL' as never, source: 'USER', writes: { Loan: '*' } })).toThrow(/unknown act/);
    const op = defineMoneyOperation({ name: 'unit.op.once', owner: 'x', act: 'PAY', source: 'USER', writes: { Loan: '*' } });
    expect(op.notApprover).toBe(true);
    expect(op.notBeneficiary).toBe(true);
    expect(moneyOperation('unit.op.once')).toBe(op);
    expect(() => defineMoneyOperation({ name: 'unit.op.once', owner: 'x', act: 'PAY', source: 'USER', writes: { Loan: '*' } })).toThrow(/already registered/);
    const fakeTx = { systemSetting: { findUnique: async () => null } } as never;
    const forged = { ...op };
    await expect(runMoneyOperation(fakeTx, forged, { actor: moneyActorOf({ id: 'u1' }), input: {}, operationKey: 'k' }, async () => 1)).rejects.toThrow(/not registered/);
    await expect(runMoneyOperation(fakeTx, op, { actor: null, input: {}, operationKey: 'k' }, async () => 1)).rejects.toMatchObject({ status: 401 });
    await expect(runMoneyOperation(fakeTx, op, { actor: moneyActorOf({ id: 'u1' }), input: {}, operationKey: '' }, async () => 1)).rejects.toThrow(/operation key/);
    expect(await runMoneyOperation(fakeTx, op, { actor: moneyActorOf({ id: 'u1' }), input: {}, operationKey: 'k' }, async () => 7)).toBe(7);
  });
});
