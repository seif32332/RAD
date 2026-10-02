// Job purge-attendance-biometrics (P1-FND-JOBS; PDPL minimisation, DEC-005 / DEC-011): deletes the
// evidence selfies of self punches older than `attendance_selfie_retention_days` and the face
// template + reference photo of terminated employees, then sweeps unreferenced files. Files live in
// UPLOAD_DIR/.biometric (src/lib/biometric-storage.ts); the job refuses to run without UPLOAD_DIR or
// when that folder is missing while the database still references files (wrong mount).
//
// Cross-company (iam CROSS_COMPANY_JOBS): an erasure duty is owed to every data subject whatever his
// company (a terminated employee without a company is still erased), and the folder is tenant-wide.
import 'server-only';
import path from 'path';
import { readdir, stat, unlink } from 'fs/promises';
import type { PrismaClient } from '@prisma/client';
import { logAudit } from '@/lib/audit';
import { BIOMETRIC_DIR_NAME, isBiometricName } from '@/lib/biometric-storage';
import { parseSelfAttendanceSettings, SELF_ATTENDANCE_SETTING_KEYS } from '@/lib/self-attendance';
import type { SystemContext } from '@/modules/iam';
import type { JobDefinition, JobEnv, JobSummary } from '@/modules/platform';

export const PURGE_BIOMETRICS_JOB = 'purge-attendance-biometrics';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Orphans younger than this are kept: their upload may still be committing. */
export const ORPHAN_MIN_AGE_MS = DAY_MS;

/** The retention setting, read like the app does (default and range of SELF_ATTENDANCE_SETTING_LIMITS). */
export function selfieRetentionDays(value: string | null | undefined): number {
  return parseSelfAttendanceSettings(value == null ? [] : [{ key: SELF_ATTENDANCE_SETTING_KEYS.selfieRetentionDays, value }]).selfieRetentionDays;
}

/** Biometric files older than ORPHAN_MIN_AGE_MS that no FaceProfile / AttendancePunch references. */
export function orphanBiometricNames(files: ReadonlyArray<{ name: string; mtimeMs: number }>, referenced: ReadonlySet<string>, now: Date): string[] {
  return files.filter((f) => isBiometricName(f.name) && !referenced.has(f.name) && now.getTime() - f.mtimeMs > ORPHAN_MIN_AGE_MS).map((f) => f.name);
}

async function sweepOrphans(db: PrismaClient, dir: string, now: Date): Promise<number> {
  const [profiles, punches] = await Promise.all([
    db.faceProfile.findMany({ where: { photoStoredName: { not: null } }, select: { photoStoredName: true } }),
    db.attendancePunch.findMany({ where: { selfieStoredName: { not: null } }, select: { selfieStoredName: true } }),
  ]);
  const referenced = new Set<string>([...profiles.map((p) => p.photoStoredName), ...punches.map((p) => p.selfieStoredName)].filter((x): x is string => !!x));
  const files: { name: string; mtimeMs: number }[] = [];
  for (const name of await readdir(dir)) {
    if (!isBiometricName(name)) continue;
    const info = await stat(path.join(dir, name)).catch(() => null);
    if (info && info.isFile()) files.push({ name, mtimeMs: info.mtimeMs });
  }
  let deleted = 0;
  for (const name of orphanBiometricNames(files, referenced, now)) {
    try {
      await unlink(path.join(dir, name));
      deleted += 1;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    }
  }
  return deleted;
}

export async function purgeAttendanceBiometrics(db: PrismaClient, opts: { dryRun?: boolean; now?: Date; env?: JobEnv } = {}): Promise<JobSummary> {
  const now = opts.now ?? new Date();
  const uploadDir = String((opts.env ?? process.env).UPLOAD_DIR || '').trim();
  if (!uploadDir) throw new Error('UPLOAD_DIR is not set in the tenant env file: refusing to guess where biometric files are');
  const dir = path.join(path.resolve(uploadDir), BIOMETRIC_DIR_NAME);
  const setting = await db.systemSetting.findUnique({ where: { key: SELF_ATTENDANCE_SETTING_KEYS.selfieRetentionDays }, select: { value: true } });
  const retentionDays = selfieRetentionDays(setting?.value);
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);

  const expired = await db.attendancePunch.findMany({
    where: { selfieStoredName: { not: null }, createdAt: { lt: cutoff } },
    select: { id: true, selfieStoredName: true },
    take: 5000,
  });
  const leavers = await db.faceProfile.findMany({ where: { employee: { isTerminated: true } }, select: { id: true, employeeId: true, photoStoredName: true } });
  const summary = { retentionDays, expiredSelfies: expired.length, terminatedFaceProfiles: leavers.length, filesDeleted: 0, missingFiles: 0, orphansDeleted: 0 };
  if (opts.dryRun) return { ...summary, dryRun: true };

  const referencesFiles = expired.length > 0 || leavers.some((f) => f.photoStoredName);
  const dirExists = await stat(dir).then((s) => s.isDirectory(), () => false);
  if (referencesFiles && !dirExists) {
    // Clearing the database references while the files survive elsewhere would hide them for good.
    throw new Error(`${dir} not found while the database references biometric files (is the uploads volume mounted?)`);
  }
  const removeFile = async (name: string | null) => {
    if (!isBiometricName(name)) return;
    try {
      await unlink(path.join(dir, name));
      summary.filesDeleted += 1;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') summary.missingFiles += 1;
      else throw err;
    }
  };

  for (const p of expired) {
    await removeFile(p.selfieStoredName);
    await db.attendancePunch.update({ where: { id: p.id }, data: { selfieStoredName: null, selfiePurgedAt: now } });
  }
  for (const f of leavers) {
    // File first: if it cannot be deleted the row (and its reference) stays for the next run.
    await removeFile(f.photoStoredName);
    const deleted = await db.faceProfile.deleteMany({ where: { id: f.id } });
    if (deleted.count === 0) continue;
    await logAudit({ userId: null, action: 'DELETE', entityType: 'FaceProfile', entityId: f.id, details: { employeeId: f.employeeId, reason: 'employee_terminated', job: PURGE_BIOMETRICS_JOB } });
  }
  // Orphans: files no row references any more (a crash between saving and committing, a failed delete
  // after a reset / withdrawal). Only files older than a day are touched.
  if (dirExists) summary.orphansDeleted = await sweepOrphans(db, dir, now);
  return summary;
}

export const purgeAttendanceBiometricsJob: JobDefinition<SystemContext> = {
  name: PURGE_BIOMETRICS_JOB,
  description: 'Deletes expired punch selfies and the face data of terminated employees, then unreferenced files (needs UPLOAD_DIR)',
  crossCompany: true,
  run: (ctx) => purgeAttendanceBiometrics(ctx.db, { dryRun: ctx.dryRun, now: ctx.now, env: ctx.env }),
};
