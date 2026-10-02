// Public API of the finance module (DOMAIN_BOUNDARIES §5.1). Owns PaymentRequest today and
// BankConfirmation with BL-PAY-020 (§5.2). finance sits BELOW payroll (§5.3, ADR-0002 #7): it never
// calls payroll or offboarding; the records a request pays for (settlement, loan, visa, renewal) call it.
// Every write is a transition behind money.gateway (P1-PAY-A, ARCH-004).
export {
  createPaymentRequest,
  approvePaymentRequest,
  returnPaymentRequest,
  payPaymentRequest,
  editPaymentRequest,
  deletePaymentRequest,
  closeLinkedPaymentRequests,
} from './transitions';
export type { CreatePaymentRequestInput, PaymentActInput, EditPaymentRequestInput, CloseLinkedPaymentsInput } from './transitions';
export { PAYMENT_CREATE, PAYMENT_APPROVE, PAYMENT_PAY, PAYMENT_RETURN, PAYMENT_EDIT, PAYMENT_DELETE, PAYMENT_CLOSE_LINKED } from './operations';
