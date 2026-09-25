import { createReadStream } from 'fs';
import { Readable } from 'stream';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser, type AuthUser } from '@/lib/auth';
import { forbidden, handleApiError, notFound } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { managedEmployeesWhere } from '@/lib/hr-workflows';
import {
  decideScopedFileAccess,
  fileUrlCandidates,
  findStoredFile,
  getFileTypeInfo,
  isSensitiveCategory,
  mayReadAsMuqeemDocument,
  storedNameFromSegments,
} from '@/lib/storage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** ASCII-only fallback for the Content-Disposition filename parameter. */
function asciiFileName(name: string): string {
  return name.replace(/[^\w.\-]/g, '_').slice(0, 200) || 'file';
}

/**
 * True when one of the employee's own records (written by HR / finance / management, never by the
 * employee directly) references the file: their Employee document columns, leave extension
 * documents, visa / ticket attachments, loan and settlement receipts, the medical insurance files of
 * their companies, and published circulars.
 * Employee-writable columns (avatar, attendance-correction attachments) are deliberately NOT here:
 * those files are covered by UploadedFile.uploadedById, and listing them would let an employee gain
 * access to any file by pasting its URL into their own record.
 */
async function referencedByOwnRecords(employeeId: string, storedName: string): Promise<boolean> {
  const urls = { in: fileUrlCandidates(storedName) };
  const [employee, leave, visa, loan, settlement, circular] = await Promise.all([
    prisma.employee.findFirst({
      where: {
        id: employeeId,
        OR: [
          { workContractUrl: urls },
          { iqamaCopyUrl: urls },
          { healthCertificateUrl: urls },
          { passportCopyUrl: urls },
          { ibanCertificateUrl: urls },
          { resumeUrl: urls },
        ],
      },
      select: { id: true },
    }),
    prisma.leave.findFirst({ where: { employeeId, extensionFileUrl: urls }, select: { id: true } }),
    prisma.visa.findFirst({
      where: { employeeId, OR: [{ attachmentUrl: urls }, { ticketAttachmentUrl: urls }] },
      select: { id: true },
    }),
    prisma.loan.findFirst({ where: { employeeId, receiptUrl: urls }, select: { id: true } }),
    prisma.settlement.findFirst({ where: { employeeId, transferReceiptUrl: urls }, select: { id: true } }),
    prisma.circular.findFirst({ where: { status: 'PUBLISHED', attachmentUrl: urls }, select: { id: true } }),
  ]);
  if (employee || leave || visa || loan || settlement || circular) return true;

  // Medical insurance documents of the employee's companies (shown in the portal).
  const me = await prisma.employee.findUnique({ where: { id: employeeId }, select: { actualCompanyId: true, legalCompanyId: true } });
  const companyIds = [me?.actualCompanyId, me?.legalCompanyId].filter((v): v is string => !!v);
  if (!companyIds.length) return false;
  const insurance = await prisma.medicalInsurance.findFirst({
    where: { companyId: { in: companyIds }, OR: [{ coverageUrl: urls }, { benefitsUrl: urls }] },
    select: { id: true },
  });
  return !!insurance;
}

/**
 * True when the file is a document returned by Muqeem: referenced by a MuqeemTransaction
 * (documentUrl) or a visa's official PDF (Visa.visaPdfUrl). Both columns are written only by the
 * Muqeem routes (never from user input), so they cannot be used to open other files.
 */
async function isMuqeemDocument(storedName: string): Promise<boolean> {
  const urls = { in: fileUrlCandidates(storedName) };
  const [tx, visa] = await Promise.all([
    prisma.muqeemTransaction.findFirst({ where: { documentUrl: urls }, select: { id: true } }),
    prisma.visa.findFirst({ where: { visaPdfUrl: urls }, select: { id: true } }),
  ]);
  return !!tx || !!visa;
}

/** True when `employeeId` is in the manager's team (direct reports, own branch / department). */
async function isInManagersTeam(user: AuthUser, employeeId: string): Promise<boolean> {
  const scope = await managedEmployeesWhere(prisma, user);
  if (scope === null) return true;
  const hit = await prisma.employee.findFirst({ where: { AND: [scope, { id: employeeId }] }, select: { id: true } });
  return !!hit;
}

/**
 * GET /api/files/<name> — authenticated download of an uploaded file.
 * Looks in UPLOAD_DIR first, then the legacy public/uploads folder (old /uploads/* URLs are
 * rewritten here by next.config.ts).
 *
 * Authorization (UploadedFile registry + category, decideScopedFileAccess in src/lib/storage.ts):
 * - HR / payroll / owner / admin: any file (legacy unregistered files: these roles only);
 * - BRANCH_MANAGER / DEPT_MANAGER: files registered to an employee of their team;
 * - other back-office roles: CONTRACT / OTHER documents or files they uploaded;
 * - sensitive categories (IDENTITY, PASSPORT, HEALTH, BANK): the roles above and the employee only,
 *   except the documents returned by Muqeem (visa PDFs), also readable by GOV_RELATIONS;
 * - everyone: their own files, and files referenced by their own records.
 * Every successful read of a sensitive-category file is written to the AuditLog (VIEW).
 */
export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const user = await requireUser();
    const { path: segments } = await params;

    const storedName = storedNameFromSegments(segments ?? []);
    if (!storedName) throw notFound('الملف غير موجود');

    const entry = await prisma.uploadedFile.findUnique({
      where: { storedName },
      select: { uploadedById: true, employeeId: true, category: true, isPublic: true },
    });
    const decision = decideScopedFileAccess({ id: user.id, role: user.role, employeeId: user.employeeId }, entry);
    const byReferences = async () => !!user.employeeId && (await referencedByOwnRecords(user.employeeId, storedName));
    const allowed =
      decision === 'allow' ||
      (decision === 'check-team' && !!entry?.employeeId && (await isInManagersTeam(user, entry.employeeId))) ||
      ((decision === 'check-references' || decision === 'check-team') && (await byReferences())) ||
      // GOV_RELATIONS: the visa / Muqeem PDFs they issue (IDENTITY), and nothing else of that category.
      (mayReadAsMuqeemDocument(user, entry) && (await isMuqeemDocument(storedName)));
    // Same answer whether the file exists or not, so names cannot be probed.
    if (!allowed) throw forbidden('لا تملك صلاحية الوصول إلى هذا الملف');

    const file = await findStoredFile(segments ?? []);
    if (!file) throw notFound('الملف غير موجود');

    const sensitive = !!entry && isSensitiveCategory(entry.category);
    if (sensitive) {
      await logAudit({
        userId: user.id,
        action: 'VIEW',
        entityType: 'File',
        entityId: storedName,
        details: { category: entry?.category, employeeId: entry?.employeeId, role: user.role },
        ipAddress: getClientIp(req),
      });
    }

    const { mime, inline } = getFileTypeInfo(file.fileName);
    const disposition = `${inline ? 'inline' : 'attachment'}; filename="${asciiFileName(file.fileName)}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`;

    const headers: Record<string, string> = {
      'Content-Type': mime,
      'Content-Length': String(file.size),
      'Content-Disposition': disposition,
      'X-Content-Type-Options': 'nosniff',
      // Sensitive documents are never cached, so every read goes through the audited path.
      'Cache-Control': sensitive ? 'private, no-store' : 'private, max-age=3600',
      'Last-Modified': file.mtime.toUTCString(),
      'Cross-Origin-Resource-Policy': 'same-origin',
    };
    // Defense in depth: nothing served from here may run scripts. PDFs are excluded because a
    // sandbox CSP stops Chrome's built-in PDF viewer from rendering them.
    if (mime !== 'application/pdf') {
      headers['Content-Security-Policy'] = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";
    }

    const stream = Readable.toWeb(createReadStream(file.absolutePath)) as unknown as ReadableStream<Uint8Array>;
    return new Response(stream, { status: 200, headers });
  } catch (err) {
    return handleApiError(err, 'files:GET');
  }
}
