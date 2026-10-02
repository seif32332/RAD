// people.lockEmployees (ADR-0002 #2) against a real PostgreSQL (LCY_IT=1, THROWAWAY database).
import { randomUUID } from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { employeeFixture } from '@/test/money-fixtures';

const RUN = process.env.LCY_IT === '1';

describe.skipIf(!RUN)('people.lockEmployees on PostgreSQL', { timeout: 60_000 }, async () => {
  const { prisma } = await import('@/lib/prisma');
  const { lockEmployees } = await import('@/modules/people');
  const t = randomUUID().replace(/-/g, '').slice(0, 10);
  const mk = async (k: string) => (await prisma.company.create({ data: { nameArabic: k, commercialRegNum: `PPL-${k}-${t}`, commercialRegExp: new Date('2030-01-01') } })).id;
  let a = '';
  let b = '';
  beforeAll(async () => {
    a = await mk('a');
    b = await mk('b');
  });
  let n = 0;
  const employee = (legalCompanyId: string) =>
    employeeFixture({
        employeeId: `PPL-${t}-${++n}`, firstNameArabic: 'م', lastNameArabic: 'ع', nationality: 'SA', iqamaOrIdNumber: `PPL${t}${n}`,
        iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'M', joinDate: new Date('2024-01-01'), basicSalary: 5000, legalCompanyId,
      });

  it('locks in ascending id order inside the companies; another company is 403, an unknown id 404', async () => {
    const e1 = await employee(a);
    const e2 = await employee(a);
    const e3 = await employee(b);
    const rows = await prisma.$transaction((tx) => lockEmployees(tx, [e2.id, e1.id, e1.id], [a]));
    expect(rows.map((r) => r.id)).toEqual([e1.id, e2.id].sort());
    await expect(prisma.$transaction((tx) => lockEmployees(tx, [e1.id, e3.id], [a]))).rejects.toMatchObject({ status: 403 });
    await expect(prisma.$transaction((tx) => lockEmployees(tx, [randomUUID()], 'ALL'))).rejects.toMatchObject({ status: 404 });
    expect((await prisma.$transaction((tx) => lockEmployees(tx, [e3.id], 'ALL'))).map((r) => r.legalCompanyId)).toEqual([b]);
    await expect(lockEmployees(prisma as never, [e1.id], [a])).rejects.toThrow(/transaction/);
  });

  it('a second transaction waits for the lock (serialised writers)', async () => {
    const e = await employee(a);
    const order: string[] = [];
    await Promise.all([
      prisma.$transaction(async (tx) => {
        await lockEmployees(tx, [e.id], [a]);
        order.push('first-locked');
        await new Promise((r) => setTimeout(r, 300));
        order.push('first-done');
      }),
      new Promise((r) => setTimeout(r, 50)).then(() =>
        prisma.$transaction(async (tx) => {
          await lockEmployees(tx, [e.id], [a]);
          order.push('second-locked');
        }),
      ),
    ]);
    expect(order).toEqual(['first-locked', 'first-done', 'second-locked']);
  });
});
