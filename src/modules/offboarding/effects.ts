// The settlement effect log (BL-LCY-015, LCY-M1; DEC-PO-128 / ADR-0004 #1): table SettlementEffect,
// one row per value a settlement approval changed, with its value before and after. Append-only
// (trigger of 9zd); written by recordSettlementEffects (./transitions), read by settlementEffects.
import type { Prisma, SettlementEffect } from '@prisma/client';
import type { TxClient } from '@/modules/platform';

/** The kinds of effect (CHECK SettlementEffect_kind_check of 9zd). */
export const SETTLEMENT_EFFECT_KINDS = ['LOAN', 'OVERTIME', 'PAYROLL_DRAFT', 'LEAVE_ACCRUAL', 'PAYMENT_REQUEST', 'EMPLOYMENT', 'LOGIN'] as const;
export type SettlementEffectKind = (typeof SETTLEMENT_EFFECT_KINDS)[number];

/** One effect: the row it touched (the employee for employee-level values) and the values before / after. */
export interface SettlementEffectInput {
  kind: SettlementEffectKind;
  refId: string;
  before: Prisma.InputJsonValue | null;
  after: Prisma.InputJsonValue | null;
}

/** The effect log of a settlement, in recording order. */
export function settlementEffects(db: Pick<TxClient, 'settlementEffect'>, settlementId: string): Promise<SettlementEffect[]> {
  return db.settlementEffect.findMany({ where: { settlementId }, orderBy: [{ recordedAt: 'asc' }, { kind: 'asc' }, { refId: 'asc' }] });
}
