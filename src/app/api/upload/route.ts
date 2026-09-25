import { NextResponse } from 'next/server';
import path from 'path';
import { unlink } from 'fs/promises';
import { prisma } from '@/lib/prisma';
import { getClientIp, getSessionUser } from '@/lib/auth';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';
import { HttpError, badRequest, handleApiError } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit';
import {
  ANONYMOUS_UPLOAD_POLICY,
  AUTHENTICATED_UPLOAD_POLICY,
  FILE_CATEGORIES,
  checkUploadMeta,
  getUploadDir,
  inferFileCategory,
  isFileCategory,
  registryMimeType,
  sanitizeDisplayName,
  saveUpload,
  validateUpload,
} from '@/lib/storage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Extra allowance for multipart boundaries/headers when checking Content-Length up front. */
const MULTIPART_OVERHEAD = 64 * 1024;
/**
 * Next buffers at most this many request-body bytes when a proxy/middleware runs
 * (next.config `experimental.proxyClientMaxBodySize`, default 10 MB); anything beyond is cut off.
 * Keep this in sync if that limit is raised.
 */
const PROXY_BODY_LIMIT = 10 * 1024 * 1024;

function tooManyRequests(retryAfterSeconds: number) {
  const message = 'تم تجاوز عدد مرات رفع الملفات المسموح بها، يرجى المحاولة لاحقاً';
  return NextResponse.json(
    { message, error: message },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
}

/**
 * POST multipart/form-data { file }.
 * - Logged-in users: allow-listed document/image types, up to 10 MB.
 * - Anonymous (public job application form only): pdf/doc/docx/jpg/png, up to 5 MB, 10 uploads/hour/IP.
 * Optional form field `employeeId` (staff only): the Employee.id the document belongs to.
 * Optional form field `category` (IDENTITY, PASSPORT, HEALTH, BANK, CONTRACT, OTHER; 400 when invalid),
 * or `field`: the record field the file is for (e.g. 'iqamaCopyUrl'), from which the category is
 * inferred. The category drives who may download the file (see /api/files). Anonymous uploads are
 * never categorized (HR-only unless referenced).
 * Every upload is recorded in the UploadedFile registry (used by /api/files for authorization).
 * Response: { message, url: '/api/files/<name>', fileName, size }.
 */
export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    const ip = getClientIp(req);
    const policy = user ? AUTHENTICATED_UPLOAD_POLICY : ANONYMOUS_UPLOAD_POLICY;

    const limit = user ? rateLimit(`upload:user:${user.id}`, 300, 60 * 60_000) : rateLimit(`upload:anon:${ip}`, 10, 60 * 60_000);
    if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

    const declared = Number(req.headers.get('content-length') || 0);
    if (declared > policy.maxBytes + MULTIPART_OVERHEAD) {
      throw new HttpError(413, `حجم الملف يتجاوز الحد المسموح (${Math.round(policy.maxBytes / (1024 * 1024))} ميجابايت)`);
    }

    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      // The proxy (src/proxy.ts) buffers at most PROXY_BODY_LIMIT bytes of the body; a larger
      // upload arrives truncated and fails to parse. Report that as "too large", not "malformed".
      if (declared >= PROXY_BODY_LIMIT) {
        throw new HttpError(413, `حجم الملف يتجاوز الحد المسموح (${Math.round(policy.maxBytes / (1024 * 1024))} ميجابايت)`);
      }
      throw badRequest('صيغة الطلب غير صحيحة، يجب إرسال الملف كـ multipart/form-data');
    }

    const entry = formData.get('file');
    if (!entry || typeof entry === 'string') throw badRequest('لم يتم إرسال أي ملف');
    const file = entry;

    // Owner employee of the document: staff may upload on behalf of an employee (validated);
    // everyone else's uploads belong to their own employee file.
    let ownerEmployeeId: string | null = user?.employeeId ?? null;
    const requestedEmployee = formData.get('employeeId');
    if (user && roleIn(user.role, ROLE_GROUPS.STAFF) && typeof requestedEmployee === 'string' && requestedEmployee.trim()) {
      const id = requestedEmployee.trim();
      if (id.length > 100) throw badRequest('معرّف الموظف غير صالح');
      const exists = await prisma.employee.findUnique({ where: { id }, select: { id: true } });
      if (!exists) throw badRequest('الموظف المحدد غير موجود');
      ownerEmployeeId = exists.id;
    }

    // Document category: explicit value (validated) or inferred from the record field name.
    let category: string | null = null;
    if (user) {
      const rawCategory = formData.get('category');
      const rawField = formData.get('field');
      if (typeof rawCategory === 'string' && rawCategory.trim()) {
        const c = rawCategory.trim().toUpperCase();
        if (!isFileCategory(c)) throw badRequest(`تصنيف المستند غير صالح. القيم المسموحة: ${FILE_CATEGORIES.join(', ')}`);
        category = c;
      } else if (typeof rawField === 'string' && rawField.trim()) {
        // A known field that is not a sensitive document is still classified (OTHER), so that
        // 'unclassified' only ever means 'unknown origin' (treated as restricted).
        category = inferFileCategory(rawField.trim().slice(0, 100)) ?? 'OTHER';
      }
    }

    // Size/extension are checked before reading the content.
    const pre = checkUploadMeta(file.name, file.size, policy);
    if (!pre.ok) throw new HttpError(pre.status, pre.message);

    const data = new Uint8Array(await file.arrayBuffer());
    const result = validateUpload(file.name, data.byteLength, data, policy);
    if (!result.ok) throw new HttpError(result.status, result.message);

    const { storedName, url } = await saveUpload(data, result.ext);
    const displayName = sanitizeDisplayName(file.name);

    try {
      await prisma.uploadedFile.create({
        data: {
          storedName,
          originalName: displayName,
          mimeType: registryMimeType(storedName),
          size: data.byteLength,
          isPublic: !user,
          uploadedById: user?.id ?? null,
          employeeId: ownerEmployeeId,
          category,
        },
      });
    } catch (err) {
      // An unregistered file could never be downloaded by its owner: remove it and fail.
      await unlink(path.join(getUploadDir(), storedName)).catch(() => undefined);
      throw err;
    }

    await logAudit({
      userId: user?.id ?? null,
      action: 'CREATE',
      entityType: 'File',
      entityId: storedName,
      details: { fileName: displayName, size: data.byteLength, anonymous: !user, employeeId: ownerEmployeeId, category },
      ipAddress: ip,
    });

    return NextResponse.json({
      message: 'تم رفع الملف بنجاح',
      url,
      fileName: displayName,
      size: data.byteLength,
      category,
    });
  } catch (err) {
    return handleApiError(err, 'upload:POST');
  }
}
