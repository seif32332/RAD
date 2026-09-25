// Uniform API error handling. Every route handler should end with:
//   } catch (err) { return handleApiError(err, 'route-name'); }
import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { ZodError, type ZodTypeAny, type z } from 'zod';

export class HttpError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message = 'بيانات الطلب غير صالحة', details?: unknown) => new HttpError(400, message, details);
export const unauthorized = (message = 'يجب تسجيل الدخول أولاً') => new HttpError(401, message);
export const forbidden = (message = 'ليس لديك صلاحية لتنفيذ هذا الإجراء') => new HttpError(403, message);
export const notFound = (message = 'العنصر المطلوب غير موجود') => new HttpError(404, message);
export const conflict = (message = 'تعارض مع بيانات موجودة', details?: unknown) => new HttpError(409, message, details);

/** JSON error body. Both `message` and `error` are set because existing pages read either. */
export function jsonError(status: number, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ message, error: message, ...(extra || {}) }, { status });
}

/** Maps any thrown value to a safe JSON response. Never leaks internal error text. */
export function handleApiError(err: unknown, context = 'api'): NextResponse {
  if (err instanceof HttpError) {
    return jsonError(err.status, err.message, err.details !== undefined ? { details: err.details } : undefined);
  }
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    // Prefer the Arabic rule messages from src/lib/validation.ts (e.g. password policy); fall back
    // to listing the invalid fields when zod produced its default English text.
    const isArabic = (m: string) => /[؀-ۿ]/.test(m);
    const arabic = [...new Set(issues.map((i) => i.message).filter(isArabic))];
    const fields = issues.filter((i) => !isArabic(i.message)).map((i) => i.path).filter(Boolean);
    const parts = [...arabic, ...(fields.length ? [`حقول غير صالحة: ${fields.join('، ')}`] : [])];
    return jsonError(400, parts.length ? parts.join(' — ') : 'بيانات الطلب غير صالحة', { details: issues });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002':
        return jsonError(409, 'القيمة مستخدمة مسبقاً ولا يمكن تكرارها', { details: { fields: err.meta?.target ?? null } });
      case 'P2025':
        return jsonError(404, 'العنصر المطلوب غير موجود');
      case 'P2003':
      case 'P2014':
        return jsonError(409, 'لا يمكن تنفيذ العملية لارتباط العنصر ببيانات أخرى');
      default:
        break;
    }
  }
  if (err instanceof Prisma.PrismaClientValidationError) {
    console.error(`[${context}] prisma validation error:`, err.message);
    return jsonError(400, 'بيانات الطلب غير صالحة');
  }
  if (err instanceof SyntaxError) {
    return jsonError(400, 'صيغة البيانات المرسلة غير صحيحة');
  }
  console.error(`[${context}] unexpected error:`, err);
  return jsonError(500, 'حدث خطأ غير متوقع، يرجى المحاولة لاحقاً');
}

/** Parse and validate a JSON body. Throws HttpError(400) / ZodError on invalid input. */
export async function parseBody<S extends ZodTypeAny>(req: Request, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw badRequest('صيغة البيانات المرسلة غير صحيحة');
  }
  return schema.parse(raw);
}

/** Validate URL search params (as a plain object of strings). */
export function parseQuery<S extends ZodTypeAny>(req: Request, schema: S): z.infer<S> {
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  return schema.parse(params);
}

/** Keep only keys whose value is not undefined (for partial updates). */
export function definedOnly<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
