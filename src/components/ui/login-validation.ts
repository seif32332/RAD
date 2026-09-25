// Client-side checks of the sign-in form (pure, unit-tested). They only produce friendly Arabic
// messages before a request is sent; the server remains the authority on credentials.

export type LoginField = 'email' | 'password';
export type LoginErrors = Partial<Record<LoginField, string>>;

/** Loose shape check (something@something.tld, no spaces); the server does the real lookup. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateLoginForm(input: { email: string; password: string }): LoginErrors {
  const errors: LoginErrors = {};
  const email = input.email.trim();
  if (!email) errors.email = 'أدخل البريد الإلكتروني';
  else if (!EMAIL_SHAPE.test(email)) errors.email = 'صيغة البريد الإلكتروني غير صحيحة، مثال: name@company.com';
  if (!input.password) errors.password = 'أدخل كلمة المرور';
  return errors;
}

/** Fields with an error, in the order they appear in the form (for the summary and focus). */
export function errorFields(errors: LoginErrors): LoginField[] {
  return (['email', 'password'] as const).filter((f) => !!errors[f]);
}
