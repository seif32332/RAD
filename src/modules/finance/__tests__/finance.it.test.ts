// finance's payment-request transitions on a real PostgreSQL (P1-PAY-A, BL-PAY-003 / 008): every export
// of transitions.ts called twice with one key, sequentially and concurrently (ARCH-014), and the
// maker-checker without exceptions (BR-PAY-001 / 002, DEC-PO-005): the requester never approves, the
// payer is none of the requester, the approver and the beneficiary — SUPER_ADMIN included — and a row
// with neither a requester nor an approver is not paid before attestation (BR-PAY-015).
//
// Opt-in: PAY_IT=1 with DATABASE_URL on a THROWAWAY migrated database (rows are not cleaned up).
import { randomUUID } from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { employeeFixture } from '@/test/money-fixtures';

const RUN = process.env.PAY_IT === '1';

describe.skipIf(!RUN)('finance payment requests on PostgreSQL (P1-PAY-A)', { timeout: 180_000 }, async () => {
  if (!RUN) return;
  const { prisma } = await import('@/lib/prisma');
  const finance = await import('@/modules/finance');
  const { runPayrollTransaction } = await import('@/modules/payroll');
  const { moneyFixture } = await import('@/test/money-fixtures');

  const tag = randomUUID().replace(/-/g, '').slice(0, 8);
  type Actor = { id: string; role: string; employeeId: string | null };
  const a = {} as Record<'gov' | 'owner' | 'fin' | 'fin2' | 'superAdmin' | 'beneficiary', Actor>;
  let employeeId = '';

  beforeAll(async () => {
    const co = await prisma.company.create({ data: { nameArabic: `مالية ${tag}`, commercialRegNum: `FN${tag}`, commercialRegExp: new Date('2030-01-01') } });
    employeeId = (
      await employeeFixture({
          employeeId: `FN-${tag}`, firstNameArabic: 'م', lastNameArabic: 'ن', nationality: 'SA', iqamaOrIdNumber: `FN${tag}`, iqamaOrIdExp: new Date('2030-01-01'),
          dateOfBirth: new Date('1990-01-01'), gender: 'MALE', joinDate: new Date('2024-01-01'), basicSalary: 1, legalCompanyId: co.id,
        })
    ).id;
    for (const [k, role] of [['gov', 'GOV_RELATIONS'], ['owner', 'COMPANY_ADMIN'], ['fin', 'FINANCE_MANAGER'], ['fin2', 'PAYROLL_ADMIN'], ['superAdmin', 'SUPER_ADMIN'], ['beneficiary', 'FINANCE_MANAGER']] as const) {
      const u = await prisma.user.create({ data: { email: `fn-${k}-${tag}@example.test`, passwordHash: 'x', role } });
      a[k] = { id: u.id, role, employeeId: k === 'beneficiary' ? employeeId : null };
    }
    await prisma.employee.update({ where: { id: employeeId }, data: { userId: a.beneficiary.id } });
  });

  const tx = <T,>(fn: (t: import('@/modules/platform').TxClient) => Promise<T>) => runPayrollTransaction(prisma, fn);
  const audits = (key: string) => prisma.auditRecord.count({ where: { operationKey: key } });
  const create = (actor: Actor, key: string, over: Partial<Parameters<typeof finance.createPaymentRequest>[1]> = {}) =>
    tx((t) => finance.createPaymentRequest(t, { actor, title: `طلب ${tag}`, amount: 150.555, status: 'PENDING_OWNER', operationKey: key, ...over }));

  async function twice<T>(make: () => Promise<{ key: string; call: () => Promise<T> }>) {
    const s = await make();
    const x = await s.call();
    expect(await s.call()).toEqual(x);
    expect(await audits(s.key)).toBe(1);
    const c = await make();
    const both = await Promise.allSettled([c.call(), c.call()]);
    expect(both.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await audits(c.key)).toBe(1);
    return x;
  }

  it('createPaymentRequest double call: one request, the requester recorded, the amount in halalas', async () => {
    const r = await twice(async () => {
      const key = `it:pr:${randomUUID()}`;
      return { key, call: () => create(a.gov, key) };
    });
    expect([r.requestedById, r.amount, r.status]).toEqual([a.gov.id, 150.56, 'PENDING_OWNER']);
  });

  it('approvePaymentRequest double call; the requester never approves his own request, SUPER_ADMIN included (BL-PAY-008)', async () => {
    const ap = await twice(async () => {
      const key = `it:ap:${randomUUID()}`;
      const r = await create(a.gov, `it:pr:${randomUUID()}`);
      return { key, call: () => tx((t) => finance.approvePaymentRequest(t, { actor: a.owner, paymentRequestId: r.id, operationKey: key })) };
    });
    expect([ap.status, ap.approvedById]).toEqual(['PENDING_FINANCE', a.owner.id]);
    const own = await create(a.superAdmin, `it:pr:${randomUUID()}`);
    await expect(tx((t) => finance.approvePaymentRequest(t, { actor: a.superAdmin, paymentRequestId: own.id, operationKey: `it:${randomUUID()}` }))).rejects.toMatchObject({
      status: 403,
      details: { code: 'MONEY_GUARD_BLOCKED', reasons: ['SAME_PERSON_TWICE'] },
    });
    // The beneficiary does not approve money that goes to him.
    const toHim = await create(a.gov, `it:pr:${randomUUID()}`, { beneficiaryEmployeeId: employeeId });
    await expect(tx((t) => finance.approvePaymentRequest(t, { actor: a.beneficiary, paymentRequestId: toHim.id, operationKey: `it:${randomUUID()}` }))).rejects.toMatchObject({ status: 403 });
  });

  it('payPaymentRequest double call; the payer is none of requester, approver, beneficiary; a row with neither recorded is refused (no UNKNOWN_REQUESTER pass)', async () => {
    const approved = async (over: Partial<Parameters<typeof finance.createPaymentRequest>[1]> = {}) => {
      const r = await create(a.gov, `it:pr:${randomUUID()}`, over);
      return tx((t) => finance.approvePaymentRequest(t, { actor: a.owner, paymentRequestId: r.id, operationKey: `it:${randomUUID()}` }));
    };
    const paid = await twice(async () => {
      const key = `it:pay:${randomUUID()}`;
      const r = await approved();
      return { key, call: () => tx((t) => finance.payPaymentRequest(t, { actor: a.fin, paymentRequestId: r.id, receiptUrl: '/r.pdf', operationKey: key })) };
    });
    expect([paid.status, paid.paidById]).toEqual(['PAID', a.fin.id]);
    const r1 = await approved();
    await expect(tx((t) => finance.payPaymentRequest(t, { actor: a.owner, paymentRequestId: r1.id, receiptUrl: '/r.pdf', operationKey: `it:${randomUUID()}` }))).rejects.toMatchObject({ status: 403, details: { reasons: ['PAYER_IS_APPROVER'] } });
    await expect(tx((t) => finance.payPaymentRequest(t, { actor: a.gov, paymentRequestId: r1.id, receiptUrl: '/r.pdf', operationKey: `it:${randomUUID()}` }))).rejects.toMatchObject({ status: 403 });
    const r2 = await approved({ beneficiaryEmployeeId: employeeId });
    await expect(tx((t) => finance.payPaymentRequest(t, { actor: a.beneficiary, paymentRequestId: r2.id, receiptUrl: '/r.pdf', operationKey: `it:${randomUUID()}` }))).rejects.toMatchObject({ status: 403, details: { reasons: ['SELF_BENEFICIARY'] } });
    const legacy = await moneyFixture((t) => t.paymentRequest.create({ data: { title: 'legacy', amount: 10, status: 'PENDING_FINANCE' } }));
    await expect(tx((t) => finance.payPaymentRequest(t, { actor: a.superAdmin, paymentRequestId: legacy.id, receiptUrl: '/r.pdf', operationKey: `it:${randomUUID()}` }))).rejects.toMatchObject({ status: 403, details: { reasons: ['UNKNOWN_APPROVER'] } });
    // Race: two payers of one request, one wins.
    const r3 = await approved();
    const race = await Promise.allSettled([a.fin, a.fin2].map((p) => tx((t) => finance.payPaymentRequest(t, { actor: p, paymentRequestId: r3.id, receiptUrl: '/r.pdf', operationKey: `it:${randomUUID()}` }))));
    expect(race.filter((x) => x.status === 'fulfilled').length).toBe(1);
    expect((race.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason.status).toBe(409);
  });

  it('returnPaymentRequest / editPaymentRequest / deletePaymentRequest double calls', async () => {
    const rt = await twice(async () => {
      const key = `it:ret:${randomUUID()}`;
      const r = await create(a.gov, `it:pr:${randomUUID()}`);
      return { key, call: () => tx((t) => finance.returnPaymentRequest(t, { actor: a.fin, paymentRequestId: r.id, reason: 'رقم سداد منتهي', operationKey: key })) };
    });
    expect(rt.status).toBe('RETURNED');
    const ed = await twice(async () => {
      const key = `it:edit:${randomUUID()}`;
      const r = await create(a.gov, `it:pr:${randomUUID()}`);
      return { key, call: () => tx((t) => finance.editPaymentRequest(t, { actor: a.gov, paymentRequestId: r.id, fields: { amount: 99.999 }, operationKey: key })) };
    });
    expect(ed.amount).toBe(100);
    const dl = await twice(async () => {
      const key = `it:del:${randomUUID()}`;
      const r = await create(a.gov, `it:pr:${randomUUID()}`);
      return { key, call: () => tx((t) => finance.deletePaymentRequest(t, { actor: a.gov, paymentRequestId: r.id, linkedEntityTypes: ['VISA', 'SETTLEMENT', 'LOAN'], operationKey: key })) };
    });
    expect(dl.deleted).toBe(true);
    // An approved request's amount is not edited any more (it would bypass the approval).
    const r = await create(a.gov, `it:pr:${randomUUID()}`);
    await tx((t) => finance.approvePaymentRequest(t, { actor: a.owner, paymentRequestId: r.id, operationKey: `it:${randomUUID()}` }));
    await expect(tx((t) => finance.editPaymentRequest(t, { actor: a.gov, paymentRequestId: r.id, fields: { amount: 1 }, operationKey: `it:${randomUUID()}` }))).rejects.toMatchObject({ status: 409 });
  });

  it('closeLinkedPaymentRequests double call (sequential and concurrent): the linked requests close once', async () => {
    const entityId = randomUUID();
    await create(a.gov, `it:pr:${randomUUID()}`, { entityType: 'VISA', entityId, status: 'PENDING_FINANCE' });
    const key = `it:close:${randomUUID()}`;
    const run = () => prisma.$transaction((t) => finance.closeLinkedPaymentRequests(t, { entityType: 'VISA', entityIds: [entityId], from: ['PENDING_OWNER', 'PENDING_FINANCE'], to: 'RETURNED', returnReason: 'x', operationKey: key }));
    expect((await run()).closed).toBe(1);
    expect((await run()).closed).toBe(0);
    const other = randomUUID();
    await create(a.gov, `it:pr:${randomUUID()}`, { entityType: 'VISA', entityId: other });
    const both = await Promise.all([0, 1].map(() => prisma.$transaction((t) => finance.closeLinkedPaymentRequests(t, { entityType: 'VISA', entityIds: [other], from: ['PENDING_OWNER'], to: 'RETURNED', operationKey: `it:${randomUUID()}` }))));
    expect(both.map((b) => b.closed).reduce((s, v) => s + v, 0)).toBe(1);
  });
});
