// File storage for uploaded documents.
//
// Files live OUTSIDE `public/` (Next does not serve files added to public/ after the build,
// and deploys wipe/copy that folder). Location: env UPLOAD_DIR, default <cwd>/uploads.
// Files are served only through the authenticated route /api/files/<name>.
//
// The pure helpers (extension parsing, magic-byte checks, path resolution) have no I/O so they
// can be unit tested; saveUpload / findStoredFile do the disk work.
import 'server-only';
import path from 'path';
import { randomUUID } from 'crypto';
import { mkdir, writeFile, stat } from 'fs/promises';

/** Public URL prefix of the authenticated download route. */
export const FILES_URL_PREFIX = '/api/files/';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB (authenticated users)
export const MAX_ANONYMOUS_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB (public job application form)

export interface FileTypeInfo {
  mime: string;
  /** Served with Content-Disposition: inline (viewable in the browser). */
  inline: boolean;
}

/** Allow-listed upload types. SVG / HTML / XML / scripts are NEVER accepted. */
export const FILE_TYPES: Readonly<Record<string, FileTypeInfo>> = {
  pdf: { mime: 'application/pdf', inline: true },
  jpg: { mime: 'image/jpeg', inline: true },
  jpeg: { mime: 'image/jpeg', inline: true },
  png: { mime: 'image/png', inline: true },
  webp: { mime: 'image/webp', inline: true },
  gif: { mime: 'image/gif', inline: true },
  doc: { mime: 'application/msword', inline: false },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', inline: false },
  xls: { mime: 'application/vnd.ms-excel', inline: false },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', inline: false },
  csv: { mime: 'text/csv; charset=utf-8', inline: false },
  txt: { mime: 'text/plain; charset=utf-8', inline: false },
  // AutoCAD drawings (branch blueprints field accepts .dwg). Always downloaded, never rendered.
  dwg: { mime: 'application/acad', inline: false },
};

export const ALLOWED_EXTENSIONS: readonly string[] = Object.keys(FILE_TYPES);

/** Types accepted from anonymous visitors (public job application CV upload). */
export const ANONYMOUS_EXTENSIONS: readonly string[] = ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png'];

const FALLBACK_TYPE: FileTypeInfo = { mime: 'application/octet-stream', inline: false };

/** Absolute directory where new uploads are stored. */
export function getUploadDir(): string {
  const configured = process.env.UPLOAD_DIR?.trim();
  return path.resolve(configured || path.join(process.cwd(), 'uploads'));
}

/** Legacy location used by the old upload route (URLs stored in the DB as /uploads/<name>). */
export function getLegacyUploadDir(): string {
  return path.resolve(path.join(process.cwd(), 'public', 'uploads'));
}

/** Lower-case extension without the dot, or null when missing/invalid. */
export function getExtension(fileName: string | null | undefined): string | null {
  if (!fileName) return null;
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const idx = base.lastIndexOf('.');
  if (idx <= 0 || idx === base.length - 1) return null;
  const ext = base.slice(idx + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : null;
}

/** Content type + disposition for serving a stored file. Unknown extensions are forced to download. */
export function getFileTypeInfo(fileName: string): FileTypeInfo {
  const ext = getExtension(fileName);
  return (ext && FILE_TYPES[ext]) || FALLBACK_TYPE;
}

function startsWithBytes(buf: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (buf[offset + i] !== sig[i]) return false;
  return true;
}

function asciiHead(buf: Uint8Array, length: number): string {
  let s = '';
  const n = Math.min(length, buf.length);
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf[i]);
  return s;
}

const ZIP_SIG = [0x50, 0x4b, 0x03, 0x04] as const; // PK\x03\x04 (docx / xlsx)
const OLE_SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const; // legacy doc / xls

/** True when the content looks like markup that a browser could execute (HTML / SVG / XML). */
export function looksLikeMarkup(buf: Uint8Array): boolean {
  let head = asciiHead(buf, 512);
  // Bytes are mapped 1:1 to chars, so a UTF-8 BOM shows up as the three chars EF BB BF.
  if (head.startsWith('\xEF\xBB\xBF')) head = head.slice(3);
  head = head.trimStart().toLowerCase();
  return /^<(?:!doctype|html|head|body|script|svg|\?xml|iframe|object|embed)/.test(head);
}

/**
 * Verifies the file content matches its extension.
 * Strict signatures for pdf/png/jpg/webp/gif/docx/xlsx/dwg; doc/xls accept OLE2 (or RTF for .doc);
 * csv/txt only reject markup content.
 */
export function matchesSignature(ext: string, buf: Uint8Array): boolean {
  if (buf.length === 0) return false;
  switch (ext) {
    case 'pdf':
      // The header may be preceded by a few junk bytes in some generators.
      return asciiHead(buf, 1024).includes('%PDF-');
    case 'png':
      return startsWithBytes(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'jpg':
    case 'jpeg':
      return startsWithBytes(buf, [0xff, 0xd8, 0xff]);
    case 'gif': {
      const h = asciiHead(buf, 6);
      return h === 'GIF87a' || h === 'GIF89a';
    }
    case 'webp':
      return asciiHead(buf, 4) === 'RIFF' && asciiHead(buf, 12).slice(8) === 'WEBP';
    case 'docx':
    case 'xlsx':
      return startsWithBytes(buf, ZIP_SIG);
    case 'doc':
      return startsWithBytes(buf, OLE_SIG) || asciiHead(buf, 5) === '{\\rtf' || startsWithBytes(buf, ZIP_SIG);
    case 'xls':
      return startsWithBytes(buf, OLE_SIG) || startsWithBytes(buf, ZIP_SIG);
    case 'dwg':
      return asciiHead(buf, 4) === 'AC10';
    case 'csv':
    case 'txt':
      return !looksLikeMarkup(buf);
    default:
      return false;
  }
}

export interface UploadPolicy {
  maxBytes: number;
  extensions: readonly string[];
}

export const AUTHENTICATED_UPLOAD_POLICY: UploadPolicy = { maxBytes: MAX_UPLOAD_BYTES, extensions: ALLOWED_EXTENSIONS };
export const ANONYMOUS_UPLOAD_POLICY: UploadPolicy = { maxBytes: MAX_ANONYMOUS_UPLOAD_BYTES, extensions: ANONYMOUS_EXTENSIONS };

export type UploadValidation =
  | { ok: true; ext: string }
  | { ok: false; status: 400 | 413 | 415; message: string };

/** Name/size checks only (cheap, before reading the file content). */
export function checkUploadMeta(fileName: string, size: number, policy: UploadPolicy): UploadValidation {
  if (!size || size <= 0) return { ok: false, status: 400, message: 'الملف فارغ' };
  if (size > policy.maxBytes) {
    return { ok: false, status: 413, message: `حجم الملف يتجاوز الحد المسموح (${Math.round(policy.maxBytes / (1024 * 1024))} ميجابايت)` };
  }
  const ext = getExtension(fileName);
  if (!ext || !policy.extensions.includes(ext)) {
    return { ok: false, status: 415, message: `نوع الملف غير مسموح. الأنواع المسموحة: ${policy.extensions.join(', ')}` };
  }
  return { ok: true, ext };
}

/** Full validation of an upload against a policy (name, size and content signature). */
export function validateUpload(fileName: string, size: number, content: Uint8Array, policy: UploadPolicy): UploadValidation {
  const meta = checkUploadMeta(fileName, size, policy);
  if (!meta.ok) return meta;
  const ext = meta.ext;
  if (!matchesSignature(ext, content)) {
    return { ok: false, status: 415, message: 'محتوى الملف لا يطابق امتداده' };
  }
  return { ok: true, ext };
}

/** Random, unguessable storage name: <uuid>.<ext>. */
export function generateStoredName(ext: string): string {
  const safeExt = ext.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
  return safeExt ? `${randomUUID()}.${safeExt}` : randomUUID();
}

/** Display name safe to echo back (strips path parts and control characters). */
export function sanitizeDisplayName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  return base.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'file';
}

/**
 * Resolves URL path segments to an absolute path strictly inside `baseDir`.
 * Returns null for traversal attempts, absolute paths, null bytes, hidden files or empty input.
 */
export function resolveInside(baseDir: string, segments: readonly string[]): string | null {
  if (!segments.length || segments.length > 5) return null;
  for (const seg of segments) {
    if (!seg || seg.length > 255) return null;
    if (seg === '.' || seg === '..' || seg.startsWith('.')) return null;
    if (/[\\/:\u0000]/.test(seg)) return null;
    if (path.isAbsolute(seg)) return null;
  }
  const base = path.resolve(baseDir);
  const target = path.resolve(base, ...segments);
  if (target === base || !target.startsWith(base + path.sep)) return null;
  return target;
}

/** Writes a validated upload and returns its stored name and URL. */
export async function saveUpload(data: Uint8Array, ext: string): Promise<{ storedName: string; url: string }> {
  const dir = getUploadDir();
  await mkdir(dir, { recursive: true });
  const storedName = generateStoredName(ext);
  await writeFile(path.join(dir, storedName), data, { flag: 'wx', mode: 0o640 });
  return { storedName, url: `${FILES_URL_PREFIX}${storedName}` };
}

export interface StoredFile {
  absolutePath: string;
  fileName: string;
  size: number;
  mtime: Date;
}

/**
 * Finds a stored file by URL segments: first in UPLOAD_DIR, then in the legacy public/uploads.
 * Returns null when not found or when the path is unsafe.
 */
export async function findStoredFile(segments: readonly string[]): Promise<StoredFile | null> {
  for (const dir of [getUploadDir(), getLegacyUploadDir()]) {
    const target = resolveInside(dir, segments);
    if (!target) return null;
    try {
      const s = await stat(target);
      if (s.isFile()) {
        return { absolutePath: target, fileName: path.basename(target), size: s.size, mtime: s.mtime };
      }
    } catch {
      // not in this directory; try the next one
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Uploaded-file registry (UploadedFile table) and download authorization.
// ---------------------------------------------------------------------------

/** URL prefixes under which a stored file can be referenced from the database. */
export const FILE_URL_PREFIXES: readonly string[] = [FILES_URL_PREFIX, '/uploads/'];

/**
 * Registry key of a file from its stored URL: '/api/files/<name>' or legacy '/uploads/<name>'
 * (absolute http(s) URLs of the same paths are accepted too). Query string / hash are ignored and
 * %-escapes are decoded (the download route receives decoded path segments).
 * Returns null for anything that is not one of our upload URLs or that is unsafe.
 */
export function storedNameFromUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  let p = url.trim();
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname;
    } catch {
      return null;
    }
  }
  p = p.split(/[?#]/)[0];
  const prefix = FILE_URL_PREFIXES.find((pre) => p.startsWith(pre));
  if (!prefix) return null;
  const rest = p.slice(prefix.length);
  let segments: string[];
  try {
    segments = rest.split('/').map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  return storedNameFromSegments(segments);
}

/** Registry key from the decoded URL path segments of /api/files/<...segments>; null when unsafe. */
export function storedNameFromSegments(segments: readonly string[]): string | null {
  if (!segments.length || segments.length > 5) return null;
  for (const seg of segments) {
    if (!seg || seg.length > 255) return null;
    if (seg === '.' || seg === '..' || seg.startsWith('.')) return null;
    if (/[\\/:\u0000]/.test(seg)) return null;
  }
  return segments.join('/');
}

/**
 * Every URL spelling under which `storedName` may be saved in a record column
 * (new + legacy prefix, raw + percent-encoded). Used for exact `in` lookups.
 */
export function fileUrlCandidates(storedName: string): string[] {
  const encoded = storedName
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  const names = encoded === storedName ? [storedName] : [storedName, encoded];
  const out: string[] = [];
  for (const prefix of FILE_URL_PREFIXES) for (const n of names) out.push(`${prefix}${n}`);
  return out;
}

export interface FileRegistryEntry {
  uploadedById: string | null;
  employeeId: string | null;
}

export interface FileAccessSubject {
  id: string;
  employeeId: string | null;
  /** Back-office role (anything except EMPLOYEE). */
  isStaff: boolean;
}

/**
 * Legacy download rule (every staff role reads every file). Superseded by decideScopedFileAccess,
 * which /api/files uses; kept for its existing unit tests and as the plain-employee rule.
 * Download authorization, without the database part:
 * - 'allow'  : staff (any file), or the uploader, or the employee the file belongs to;
 * - 'deny'   : legacy file without a registry row (staff only), or a user with no employee file;
 * - 'check-references': allowed only if one of the user's own records references the file URL.
 */
export function decideFileAccess(
  subject: FileAccessSubject,
  entry: FileRegistryEntry | null,
): 'allow' | 'deny' | 'check-references' {
  if (subject.isStaff) return 'allow';
  if (!entry) return 'deny';
  if (entry.uploadedById && entry.uploadedById === subject.id) return 'allow';
  if (subject.employeeId && entry.employeeId && entry.employeeId === subject.employeeId) return 'allow';
  return subject.employeeId ? 'check-references' : 'deny';
}

/** Content type recorded in the registry for a stored name (charset parameters stripped). */
export function registryMimeType(storedName: string): string {
  return getFileTypeInfo(storedName).mime.split(';')[0].trim();
}

// ---------------------------------------------------------------------------
// Document categories and role/scope based download authorization (DEC-002 / DEC-008).
// ---------------------------------------------------------------------------

/** UploadedFile.category values. */
export const FILE_CATEGORIES = ['IDENTITY', 'PASSPORT', 'HEALTH', 'BANK', 'CONTRACT', 'OTHER'] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];

/** Personal documents: HR / payroll / owner / admin and the employee themselves only. Every read is audited. */
export const SENSITIVE_FILE_CATEGORIES: readonly FileCategory[] = ['IDENTITY', 'PASSPORT', 'HEALTH', 'BANK'];
/** Business documents other back-office roles (legal, logistics, government relations) may read. */
export const NON_PERSONAL_FILE_CATEGORIES: readonly FileCategory[] = ['CONTRACT', 'OTHER'];

export function isFileCategory(v: unknown): v is FileCategory {
  return typeof v === 'string' && (FILE_CATEGORIES as readonly string[]).includes(v);
}

export function isSensitiveCategory(v: string | null | undefined): boolean {
  return !!v && (SENSITIVE_FILE_CATEGORIES as readonly string[]).includes(v);
}

/**
 * Category of a document from the record field (form input name) it is uploaded for, e.g.
 * 'iqamaCopyUrl' -> IDENTITY, 'passportCopyUrl' -> PASSPORT, 'healthCertificateUrl' -> HEALTH,
 * 'ibanCertificateUrl' / 'ibanUrl' -> BANK, 'workContractUrl' / 'rentContractUrl' -> CONTRACT.
 * Returns null when the name says nothing (the file stays unclassified = restricted).
 */
export function inferFileCategory(fieldName: string | null | undefined): FileCategory | null {
  if (!fieldName) return null;
  const f = fieldName.toLowerCase();
  if (/passport|جواز/.test(f)) return 'PASSPORT';
  if (/iqama|national_?id|nationalid|identity|residen|border|هوية|إقامة|اقامة/.test(f) || /^id(doc|copy|card|image)?(url)?$/.test(f)) return 'IDENTITY';
  if (/health|medical|sick|صحي|طبي/.test(f)) return 'HEALTH';
  if (/iban|bank|salary_?cert|آيبان|ايبان|بنك/.test(f)) return 'BANK';
  if (/contract|agreement|عقد/.test(f)) return 'CONTRACT';
  return null;
}

/** Roles that may read any file (HR, payroll/finance, owner, admin). */
const FULL_FILE_ROLES: readonly string[] = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'HR_MANAGER', 'FINANCE_MANAGER', 'PAYROLL_ADMIN'];
/** Managers: files of their team only. */
const TEAM_FILE_ROLES: readonly string[] = ['BRANCH_MANAGER', 'DEPT_MANAGER'];

export interface ScopedFileSubject {
  id: string;
  role: string;
  employeeId: string | null;
}

export interface ScopedFileEntry extends FileRegistryEntry {
  category: string | null;
  isPublic: boolean;
}

/**
 * - 'allow'            : read it;
 * - 'deny'             : 403;
 * - 'check-team'       : allowed if entry.employeeId is in the manager's team, else like 'check-references';
 * - 'check-references' : allowed only if one of the user's own records references the file URL.
 */
export type ScopedFileDecision = 'allow' | 'deny' | 'check-team' | 'check-references';

/**
 * Download authorization by role, scope and document category (pure; the route does the DB checks):
 * - HR / payroll / owner / admin: any file, including unregistered legacy files;
 * - everyone else: never legacy unregistered files; always their own files (registered to their
 *   employee file) and, except for sensitive categories, files they uploaded;
 * - sensitive categories (IDENTITY, PASSPORT, HEALTH, BANK): nobody else (the employee's own records
 *   may still reference it: 'check-references');
 * - BRANCH_MANAGER / DEPT_MANAGER: files registered to an employee of their team;
 * - other back-office roles (legal, purchasing, government relations...): CONTRACT / OTHER documents
 *   (not public job-application uploads);
 * - otherwise the file must be referenced by the user's own records (employee self-service).
 */
export function decideScopedFileAccess(subject: ScopedFileSubject, entry: ScopedFileEntry | null): ScopedFileDecision {
  if (FULL_FILE_ROLES.includes(subject.role)) return 'allow';
  if (!entry) return 'deny';

  const ownEmployeeFile = !!subject.employeeId && !!entry.employeeId && entry.employeeId === subject.employeeId;
  if (ownEmployeeFile) return 'allow';
  const uploadedByMe = !!entry.uploadedById && entry.uploadedById === subject.id;

  if (isSensitiveCategory(entry.category)) {
    // The employee themselves: registered to them (above), their own upload not registered to anybody
    // else, or referenced by their own employee records (HR uploaded it for them).
    if (uploadedByMe && !entry.employeeId) return 'allow';
    return subject.employeeId ? 'check-references' : 'deny';
  }
  if (uploadedByMe) return 'allow';

  if (subject.role === 'EMPLOYEE') return subject.employeeId ? 'check-references' : 'deny';

  if (TEAM_FILE_ROLES.includes(subject.role)) {
    // Unclassified = restricted: a team member's document is readable only once it is classified
    // (and not sensitive, handled above). Legacy files get a category from register-legacy-uploads.
    if (entry.employeeId && entry.category) return 'check-team';
    return subject.employeeId ? 'check-references' : 'deny';
  }

  // Other back-office roles.
  if (!entry.isPublic && entry.category && (NON_PERSONAL_FILE_CATEGORIES as readonly string[]).includes(entry.category)) {
    return 'allow';
  }
  return subject.employeeId ? 'check-references' : 'deny';
}

/** Minimal DB surface needed to classify uploads (a Prisma client or transaction). */
interface UploadedFileWriter {
  uploadedFile: {
    updateMany(args: { where: { storedName: string; category?: null; employeeId?: null }; data: { category?: string; employeeId?: string } }): Promise<unknown>;
  };
}

/**
 * When document URLs are saved onto an employee record, make sure the uploaded files carry the
 * right access category and owner, whatever client uploaded them. Only fills values that are
 * still empty, so it can never re-assign a file that already belongs to someone else.
 */
export async function classifyEmployeeDocuments(
  db: UploadedFileWriter,
  employeeId: string,
  docs: Record<string, string | null | undefined>,
): Promise<void> {
  for (const [field, url] of Object.entries(docs)) {
    const storedName = storedNameFromUrl(url);
    if (!storedName) continue;
    const category = inferFileCategory(field) ?? 'OTHER';
    await db.uploadedFile.updateMany({ where: { storedName, category: null }, data: { category } });
    await db.uploadedFile.updateMany({ where: { storedName, employeeId: null }, data: { employeeId } });
  }
}
