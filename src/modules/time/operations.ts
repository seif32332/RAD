// time's money operations (money.gateway, ARCH-004): the overtime reservation links and the overtime
// decisions. The overtime row belongs to time (DOMAIN_BOUNDARIES §5.2); its links to the payroll line or
// the settlement that pays it are money columns (platform MONEY_COLUMNS), written only here.
import { defineMoneyOperation, type TxClient } from '@/modules/platform';

export interface OvertimeLinkInput {
  overtimeIds?: readonly string[];
  payrollIds?: readonly string[];
  settlementId?: string;
}

/** payroll.generate reserves the approved overtime a draft line pays; the release undoes it. */
export const OVERTIME_PAYROLL_LINK = defineMoneyOperation<OvertimeLinkInput>({
  name: 'time.overtime.linkPayroll',
  owner: 'time',
  act: 'RELEASE',
  source: 'SYSTEM',
  writes: { OvertimeRequest: ['paidInPayrollId'] },
});

/** A settlement reserves the overtime it pays (creation, approval re-check) or releases it (rejection). */
export const OVERTIME_SETTLEMENT_LINK = defineMoneyOperation<OvertimeLinkInput>({
  name: 'time.overtime.linkSettlement',
  owner: 'time',
  act: 'RELEASE',
  source: 'SYSTEM',
  writes: { OvertimeRequest: ['paidInSettlementId'] },
});

export interface OvertimeDecisionInput {
  overtimeId: string;
}

async function overtimeEmployee(tx: TxClient, input: OvertimeDecisionInput) {
  const row = await tx.overtimeRequest.findUnique({ where: { id: input.overtimeId }, select: { employeeId: true } });
  return row ? [row.employeeId] : [];
}

/** Approving or refusing overtime (BR-PAY-001: never one's own overtime; pay-to-be §11 row 5). */
export const OVERTIME_DECIDE = defineMoneyOperation<OvertimeDecisionInput>({
  name: 'time.overtime.decide',
  owner: 'time',
  act: 'APPROVE',
  source: 'USER',
  writes: { OvertimeRequest: ['status', 'decidedById', 'decidedAt'] },
  beneficiaries: overtimeEmployee,
});

export interface OvertimeAssignInput {
  employeeId: string;
}

/** A direct overtime assignment is effective at once (BL-PAY-007 makes it PENDING): never to oneself. */
export const OVERTIME_ASSIGN = defineMoneyOperation<OvertimeAssignInput>({
  name: 'time.overtime.assign',
  owner: 'time',
  act: 'CREATE_EFFECTIVE',
  source: 'USER',
  writes: { OvertimeRequest: '*' },
  beneficiaries: async (_tx, input) => [input.employeeId],
});
