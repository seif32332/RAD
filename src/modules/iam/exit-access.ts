// The end of a leaver's login (src/lib/access.ts: the documents-only window, then deactivation) runs inside
// the iam operation iam.access.endOnExit, because User.isActive is an identity column that money.gateway
// guards (BL-PAY-005, pay-to-be.md §2). The two-person gate of an attested financial approver's exit
// (DEC-PO-021 / 039 / 042) belongs to the lifecycle transition before T1 / T3 (BL-LCY-010,
// assertFinancialApproverExit); by the time the login ends, the exit is decided.
import { randomUUID } from 'crypto';
import { runMoneyOperation, type TxClient } from '@/modules/platform';
import { ACCESS_END_ON_EXIT } from './operations';

export async function runExitAccessChange<T>(tx: TxClient, userId: string, fn: (w: TxClient) => Promise<T>): Promise<T> {
  return runMoneyOperation(tx, ACCESS_END_ON_EXIT, { actor: null, input: { userId }, operationKey: `iam.access.endOnExit:${userId}:${randomUUID()}` }, (w) => fn(w));
}
