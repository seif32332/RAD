// money.gateway (ARCH-004; P1-PAY-A BL-PAY-001 / 002): the guard every money operation passes, and the
// Prisma extension that refuses a money write outside it. Re-exported by '@/modules/platform'. The
// context opener (runInMoneyContext) is NOT exported: only runMoneyOperation / reverseMoney open one.
export {
  MONEY_TABLES,
  MONEY_COLUMNS,
  MONEY_GUARDED_DELETES,
  EMPLOYEE_MONEY_COLUMNS,
  isMoneyTable,
  IDENTITY_TABLES,
  IDENTITY_COLUMNS,
  USER_CONTROL_COLUMNS,
  USER_CREDENTIAL_COLUMNS,
  VENDOR_ONLY_USER_COLUMNS,
  VENDOR_ONLY_TABLES,
  GUARDED_TABLES,
  GUARDED_RAW_COLUMNS,
  guardedColumnSpecs,
  isGuardedTable,
} from './tables';
export type { MoneyTable, ProtectedColumns } from './tables';
export { writesOf, rawWrites, rawSqlText, isDataModifyingSql, buildRelations, WRITE_OPERATIONS, RAW_OPERATIONS } from './writes';
export type { Touch, Columns } from './writes';
export { currentMoneyContext, contextAllows } from './context';
export type { MoneyContext } from './context';
export { moneyGatewayExtension, MoneyGatewayViolationError, assertWriteAllowed, protectedPart } from './extension';
export {
  MONEY_ACTS,
  BENEFICIARY_ACTS,
  PAYER_ACTS,
  GUARD_MESSAGES,
  decideSelfDealing,
  decideMakerChecker,
  decideByMode,
  decideReversal,
  isBeneficiary,
  isApprover,
} from './guards';
export type { MoneyAct, GuardActor, GuardDecision, GuardReason } from './guards';
export { moneyActorOf, defineMoneyOperation, runMoneyOperation, reverseMoney, moneyOperations, moneyOperation, MoneyGuardBlockedError } from './gateway';
export type { MoneyActor, MoneyOperation, MoneyOperationDefinition, MoneyRunSpec, MoneyRunInfo } from './gateway';
