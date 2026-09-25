#!/usr/bin/env node
/**
 * Registers files that were uploaded before the UploadedFile registry existed.
 *
 *   node scripts/register-legacy-uploads.mjs            # dry run: prints what would be inserted
 *   node scripts/register-legacy-uploads.mjs --apply    # inserts the missing registry rows
 *   node scripts/register-legacy-uploads.mjs --verbose  # also lists every file
 *
 * Why: /api/files serves a file to a plain EMPLOYEE only when the UploadedFile row says they
 * uploaded it or it belongs to their employee file (or one of their records references it).
 * Files without a row are staff-only, so run this once after deploying the registry migration.
 *
 * What it does:
 *   - scans UPLOAD_DIR (default <cwd>/uploads) and the legacy <cwd>/public/uploads (sub-folders
 *     up to 5 levels, hidden files skipped);
 *   - skips files that already have a row (storedName = path relative to the folder, '/'-joined);
 *   - uploadedById: the user of the matching upload audit entry (AuditLog CREATE/File/<name>);
 *   - employeeId: the employee whose document columns (workContractUrl, iqamaCopyUrl,
 *     healthCertificateUrl, passportCopyUrl, ibanCertificateUrl, resumeUrl) reference the file;
 *     otherwise the employee of an attendance-correction attachment; otherwise the employee
 *     linked to the uploader. A file referenced by two different employees gets no employeeId
 *     (reported as a conflict; staff can still read it).
 *   - isPublic: true only when the audit entry says it was an anonymous upload.
 *
 * Idempotent: rows are created with skipDuplicates, re-running inserts nothing new.
 * Environment: DATABASE_URL, UPLOAD_DIR (same values as the app).
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const MAX_DEPTH = 5;
const URL_PREFIXES = ['/api/files/', '/uploads/'];
const EMPLOYEE_DOC_COLUMNS = [
  'workContractUrl',
  'iqamaCopyUrl',
  'healthCertificateUrl',
  'passportCopyUrl',
  'ibanCertificateUrl',
  'resumeUrl',
];
/** Document category of an employee column (same rules as inferFileCategory in src/lib/storage.ts). */
const COLUMN_CATEGORY = {
  workContractUrl: 'CONTRACT',
  iqamaCopyUrl: 'IDENTITY',
  healthCertificateUrl: 'HEALTH',
  passportCopyUrl: 'PASSPORT',
  ibanCertificateUrl: 'BANK',
  resumeUrl: null,
};

const MIME = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  dwg: 'application/acad',
};

function uploadDirs() {
  const configured = process.env.UPLOAD_DIR?.trim();
  const main = path.resolve(configured || path.join(process.cwd(), 'uploads'));
  const legacy = path.resolve(path.join(process.cwd(), 'public', 'uploads'));
  return main === legacy ? [main] : [main, legacy];
}

/** Same rules as storedNameFromUrl in src/lib/storage.ts. */
function storedNameFromUrl(url) {
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
  const prefix = URL_PREFIXES.find((pre) => p.startsWith(pre));
  if (!prefix) return null;
  let segments;
  try {
    segments = p.slice(prefix.length).split('/').map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  if (!segments.length || segments.length > 5) return null;
  for (const seg of segments) {
    if (!seg || seg.length > 255 || seg === '.' || seg === '..' || seg.startsWith('.') || /[\\/:\u0000]/.test(seg)) return null;
  }
  return segments.join('/');
}

function mimeOf(name) {
  const idx = name.lastIndexOf('.');
  const ext = idx > 0 ? name.slice(idx + 1).toLowerCase() : '';
  return MIME[ext] ?? 'application/octet-stream';
}

async function walk(dir, rel = [], depth = 0, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return out;
    throw err;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth + 1 < MAX_DEPTH) await walk(abs, [...rel, e.name], depth + 1, out);
    } else if (e.isFile()) {
      const s = await stat(abs);
      out.push({ storedName: [...rel, e.name].join('/'), absolutePath: abs, size: s.size });
    }
  }
  return out;
}

/** storedName -> Set(employeeId) for every URL found in the given rows/columns. */
function indexReferences(rows, columns, employeeOf) {
  const map = new Map();
  for (const row of rows) {
    for (const col of columns) {
      const name = storedNameFromUrl(row[col]);
      if (!name) continue;
      if (!map.has(name)) map.set(name, new Set());
      map.get(name).add(employeeOf(row));
    }
  }
  return map;
}

function parseDetails(details) {
  if (!details) return {};
  try {
    const v = JSON.parse(details);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const dirs = uploadDirs();
    const files = [];
    const seen = new Set();
    for (const dir of dirs) {
      for (const f of await walk(dir)) {
        // UPLOAD_DIR wins over public/uploads for the same name (same lookup order as /api/files).
        if (seen.has(f.storedName)) continue;
        seen.add(f.storedName);
        files.push({ ...f, dir });
      }
    }

    const existing = new Set(
      (await prisma.uploadedFile.findMany({ select: { storedName: true } })).map((r) => r.storedName),
    );
    const missing = files.filter((f) => !existing.has(f.storedName));

    const [employees, corrections, audits, users] = await Promise.all([
      prisma.employee.findMany({ select: { id: true, ...Object.fromEntries(EMPLOYEE_DOC_COLUMNS.map((c) => [c, true])) } }),
      prisma.attendanceCorrection.findMany({ where: { attachmentUrl: { not: null } }, select: { employeeId: true, attachmentUrl: true } }),
      prisma.auditLog.findMany({
        where: { action: 'CREATE', entityType: 'File', entityId: { in: missing.map((f) => f.storedName) } },
        select: { entityId: true, userId: true, details: true },
      }),
      prisma.user.findMany({ select: { id: true, employeeProfile: { select: { id: true } } } }),
    ]);

    const docRefs = indexReferences(employees, EMPLOYEE_DOC_COLUMNS, (r) => r.id);
    // storedName -> category from the employee column that references it (sensitive documents).
    const docCategory = new Map();
    for (const row of employees) {
      for (const col of EMPLOYEE_DOC_COLUMNS) {
        const url = row[col];
        if (typeof url !== 'string' || !COLUMN_CATEGORY[col]) continue;
        const prefix = URL_PREFIXES.find((pre) => url.startsWith(pre));
        if (prefix) docCategory.set(decodeURIComponent(url.slice(prefix.length).split('?')[0]), COLUMN_CATEGORY[col]);
      }
    }
    const correctionRefs = indexReferences(corrections, ['attachmentUrl'], (r) => r.employeeId);
    const auditByName = new Map(audits.map((a) => [a.entityId, a]));
    const employeeOfUser = new Map(users.map((u) => [u.id, u.employeeProfile?.id ?? null]));

    const rows = [];
    const conflicts = [];
    for (const f of missing) {
      const audit = auditByName.get(f.storedName);
      const details = parseDetails(audit?.details);
      const uploadedById = audit?.userId && employeeOfUser.has(audit.userId) ? audit.userId : null;

      let employeeId = null;
      let source = 'none';
      for (const [label, refs] of [
        ['employee-document', docRefs],
        ['attendance-correction', correctionRefs],
      ]) {
        const set = refs.get(f.storedName);
        if (!set || !set.size) continue;
        if (set.size > 1) {
          conflicts.push({ storedName: f.storedName, source: label, employees: [...set] });
          source = `${label}-conflict`;
          break;
        }
        employeeId = [...set][0];
        source = label;
        break;
      }
      if (!employeeId && source === 'none' && uploadedById) {
        employeeId = employeeOfUser.get(uploadedById) ?? null;
        if (employeeId) source = 'uploader';
      }

      rows.push({
        data: {
          storedName: f.storedName,
          originalName: path.basename(f.storedName).slice(0, 255),
          mimeType: mimeOf(f.storedName),
          size: f.size,
          isPublic: details.anonymous === true,
          uploadedById,
          employeeId,
          category: docCategory.get(f.storedName) ?? null,
        },
        source,
        dir: f.dir,
      });
    }

    console.log(`Scanned folders: ${dirs.join(', ')}`);
    console.log(`Files found: ${files.length}, already registered: ${files.length - missing.length}, to register: ${rows.length}`);
    const bySource = rows.reduce((acc, r) => ((acc[r.source] = (acc[r.source] ?? 0) + 1), acc), {});
    console.log('employeeId resolved by:', JSON.stringify(bySource));
    if (conflicts.length) {
      console.log(`Conflicts (file referenced by several employees, registered without employeeId): ${conflicts.length}`);
      for (const c of conflicts) console.log(`  ${c.storedName} [${c.source}] -> ${c.employees.join(', ')}`);
    }
    if (VERBOSE) {
      for (const r of rows) {
        console.log(`  ${r.data.storedName}  size=${r.data.size}  employee=${r.data.employeeId ?? '-'}  uploader=${r.data.uploadedById ?? '-'}  (${r.source})`);
      }
    }

    if (!APPLY) {
      console.log('\nDry run: nothing written. Re-run with --apply to insert the rows.');
      return;
    }
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const res = await prisma.uploadedFile.createMany({ data: rows.slice(i, i + 500).map((r) => r.data), skipDuplicates: true });
      inserted += res.count;
    }
    console.log(`\nInserted ${inserted} registry row(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
