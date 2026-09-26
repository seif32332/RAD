#!/usr/bin/env node
/**
 * Seed the Nitaqat register (NitaqatActivity / NitaqatCurve) and the localization decisions register
 * (LocalizationDecision) from the official data. Idempotent; DRY-RUN by default.
 *
 *   node scripts/seed-nitaqat.mjs [<file.json> ...] [--apply] [--force-update] [--database-url URL]
 *        [--key-prefix test-] [--no-db] [--json] [--source-url URL]
 *
 * Without files the CANONICAL data committed in the repo is read: prisma/data/nitaqat-2026/{rules.json,
 * curves.json, localization-decisions.json, sources.json} (production: run after `prisma migrate deploy`).
 *
 * Immutable register: by default only MISSING rows are created; an existing row whose content differs
 * from the files is reported "DIFFERS (not changed)" with the differing fields. --force-update (with
 * --apply) rewrites those rows in place and logs every one (field: old -> new). Corrections made in the
 * app are new rows / keys and are never touched (other keys and ids).
 *
 * Accepted inputs (any combination, detected by content):
 *   - curves:    [{activityNameAr, activityCode, sizeSegment, band, m, c2026, c2027, c2028, page, confidence, note}]
 *   - decisions: [{groupNameAr, occupations, phases, minEstablishmentSize, minWage, scope, decisionNo,
 *                  decisionDate, sourceFile, page, status, note}]
 *   - rules:     {source: {url}, formula, ...} (nitaqat_rules.json): its source.url becomes the default
 *                sourceUrl of the curves (the guide PDF);
 *   - combined:  {curves: [...], decisions: [...], source?: {url}};
 *   - sources:   [{sourceFile, officialUrl, ...}] (sources.json): officialUrl is the sourceUrl of a decision
 *                whose own sourceUrl is missing (matched on the bare file name).
 *   Text is normalized (CRLF -> LF, trimmed parts, sourceFile reduced to its bare file name) so that a
 *   dry-run after an apply from the same files reports 0 differences.
 *
 * Mapping:
 *   - Activity key = <prefix> + stable slug of the Arabic name (+ "--" + slug of the size segment).
 *     Status VERIFIED_PRIMARY when every row of the activity has confidence HIGH, else AMBIGUOUS.
 *   - One NitaqatCurve per (activity, band, year) for 2026 / 2027 / 2028 (c2026 / c2027 / c2028), same m;
 *     status VERIFIED_PRIMARY for confidence HIGH, else AMBIGUOUS. Upsert on (activityKey, band, year).
 *   - Decision id = <prefix> + "loc-" + slug(groupNameAr) [+ "-" + decisionNo]; upsert on id. minWage: a
 *     number, {amount}, or {bachelor, diploma} (the higher value is stored, the others go to notes);
 *     phases keep {pct, effectiveFrom} and add minWorkers / maxWorkers parsed from "appliesTo"
 *     (">=5", "3 or 4 workers"), activity variants and the source text.
 *   - Rows seeded here are the official data; corrections made in the app are NEW rows (history).
 *
 * --apply writes (creates; plus in-place updates with --force-update) in one transaction; without it
 * nothing is written.
 * --no-db validates and prints the plan without connecting (used by the unit test).
 * Environment: DATABASE_URL (or ./.env), or --database-url.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BANDS = ['LOW_GREEN', 'MEDIUM_GREEN', 'HIGH_GREEN', 'PLATINUM'];
const YEARS = [2026, 2027, 2028];

function usage(msg) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error('Usage: node scripts/seed-nitaqat.mjs [<file.json> ...] [--apply] [--force-update] [--database-url URL] [--key-prefix P] [--no-db] [--json] [--source-url URL]');
  process.exit(2);
}

/** Canonical official data (committed): read when no file is given. */
export const CANONICAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'data', 'nitaqat-2026');
export const CANONICAL_FILES = ['rules.json', 'curves.json', 'localization-decisions.json', 'sources.json'].map((f) => path.join(CANONICAL_DIR, f));

export function parseArgs(argv) {
  const out = { files: [], apply: false, forceUpdate: false, databaseUrl: null, keyPrefix: '', noDb: false, json: false, sourceUrl: null, canonical: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--force-update') out.forceUpdate = true;
    else if (a === '--no-db') out.noDb = true;
    else if (a === '--json') out.json = true;
    else if (a === '--database-url') out.databaseUrl = argv[++i] ?? usage('--database-url needs a value');
    else if (a === '--key-prefix') out.keyPrefix = argv[++i] ?? usage('--key-prefix needs a value');
    else if (a === '--source-url') out.sourceUrl = argv[++i] ?? usage('--source-url needs a value');
    else if (a.startsWith('--')) usage(`unknown option ${a}`);
    else out.files.push(a);
  }
  if (!out.files.length) {
    out.files = [...CANONICAL_FILES];
    out.canonical = true;
  }
  if (out.forceUpdate && out.noDb) usage('--force-update needs a database');
  if (out.apply && out.noDb) usage('--apply and --no-db are exclusive');
  if (out.keyPrefix && !/^[a-z0-9-]{1,20}$/.test(out.keyPrefix)) usage('--key-prefix: lower-case letters, digits and "-" only');
  return out;
}

/** Stable slug: Arabic normalization (diacritics, tatweel, alef / ya / ta marbuta forms), lower case, "-". */
export function slug(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[ؐ-ًؚ-ٰٟۖ-ۭ]/g, '')
    .replace(/ـ/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const firstInt = (v) => {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  const m = /(\d+)/.exec(String(v ?? ''));
  return m ? Number(m[1]) : null;
};
const dateOnly = (v) => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? '').trim());
  return m ? m[1] : null;
};

/** Classifies the loaded JSON documents. */
export function classifyInputs(docs) {
  const curves = [];
  const decisions = [];
  /** Bare source file name -> official URL (sources.json). */
  const sourceFiles = {};
  let sourceUrl = null;
  const take = (arr) => {
    for (const x of arr) {
      if (x && typeof x === 'object' && 'band' in x && 'activityNameAr' in x) curves.push(x);
      else if (x && typeof x === 'object' && 'groupNameAr' in x) decisions.push(x);
      else if (x && typeof x === 'object' && typeof x.sourceFile === 'string' && isUrl(x.officialUrl)) sourceFiles[bareFile(x.sourceFile)] ??= x.officialUrl.trim();
    }
  };
  for (const d of docs) {
    if (Array.isArray(d)) take(d);
    else if (d && typeof d === 'object') {
      if (Array.isArray(d.curves)) take(d.curves);
      if (Array.isArray(d.decisions)) take(d.decisions);
      if (d.source && typeof d.source === 'object' && typeof d.source.url === 'string') sourceUrl = sourceUrl ?? d.source.url;
    }
  }
  return { curves, decisions, sourceUrl, sourceFiles };
}

const isUrl = (v) => typeof v === 'string' && /^https?:\/\//.test(v.trim());

/** "extract/mkt.pdf" or "C:\x\mkt.pdf" -> "mkt.pdf" (the canonical files carry bare names already). */
export function bareFile(v) {
  const s = String(v ?? '').trim().replace(/\\/g, '/');
  return s.slice(s.lastIndexOf('/') + 1);
}

/** Stable text: CRLF -> LF, parts trimmed, empty parts dropped, joined with `sep`; null when empty. */
export function joinText(parts, sep) {
  const out = parts.map((x) => (x === null || x === undefined ? '' : String(x).replace(/\r\n?/g, '\n').trim())).filter(Boolean);
  return out.length ? out.join(sep) : null;
}

function parseAppliesTo(text) {
  const t = String(text ?? '');
  const range = /(\d+)\s*(?:or|to|-|–|و|أو|إلى)\s*(\d+)\s*workers/i.exec(t);
  if (range) return { minWorkers: Number(range[1]), maxWorkers: Number(range[2]) };
  const ge = />=\s*(\d+)/.exec(t);
  if (ge) return { minWorkers: Number(ge[1]) };
  return {};
}

function minWageOf(v) {
  if (v === null || v === undefined) return { value: null, note: null };
  const n = num(v);
  if (n !== null) return { value: n, note: null };
  if (typeof v === 'object') {
    if (num(v.amount) !== null) return { value: num(v.amount), note: v.basis ? `أساس الأجر: ${v.basis}` : null };
    const values = Object.entries(v).filter(([, x]) => num(x) !== null).map(([k, x]) => [k, num(x)]);
    if (values.length) {
      const max = Math.max(...values.map(([, x]) => x));
      return { value: max, note: `الحد الأدنى للأجر حسب المؤهل: ${values.map(([k, x]) => `${k} ${x}`).join('، ')}؛ المخزَّن الأعلى (${max}) لأن المؤهل غير مسجّل في رديف${v.basis ? `؛ أساس الأجر: ${v.basis}` : ''}` };
    }
  }
  return { value: null, note: null };
}

/** Builds the upsert plan (pure). Returns {activities, curves, decisions, errors, warnings}. */
export function buildPlan(input, opts = {}) {
  const prefix = opts.keyPrefix ?? '';
  const defaultSource = opts.sourceUrl ?? input.sourceUrl ?? null;
  const errors = [];
  const warnings = [];
  const activities = new Map();
  const curves = [];
  for (const [i, r] of input.curves.entries()) {
    const name = String(r.activityNameAr ?? '').trim();
    if (!name) {
      errors.push(`curve #${i}: activityNameAr missing`);
      continue;
    }
    if (!BANDS.includes(r.band)) {
      errors.push(`curve #${i} (${name}): band ${r.band} unknown`);
      continue;
    }
    const m = num(r.m);
    if (m === null) {
      errors.push(`curve #${i} (${name} ${r.band}): m is not a number`);
      continue;
    }
    const segment = r.sizeSegment ? String(r.sizeSegment).trim() : null;
    const key = prefix + slug(name) + (segment ? `--${slug(segment)}` : '');
    const high = String(r.confidence ?? '').toUpperCase() === 'HIGH';
    const status = high ? 'VERIFIED_PRIMARY' : 'AMBIGUOUS';
    const page = firstInt(r.page);
    const a = activities.get(key) ?? {
      key,
      nameAr: name,
      code: r.activityCode ? String(r.activityCode).trim() : null,
      sizeSegment: segment,
      status: 'VERIFIED_PRIMARY',
      sourceUrl: r.sourceUrl ?? defaultSource,
      page,
      notes: joinText([r.activityCodeSource ? `مصدر الرمز: ${r.activityCodeSource}` : null, r.printedPage ? `الصفحة المطبوعة ${r.printedPage} (صفحة PDF ${page})` : null], '؛ '),
    };
    if (!high) a.status = 'AMBIGUOUS';
    if (page !== null && (a.page === null || page < a.page)) a.page = page;
    activities.set(key, a);
    for (const y of YEARS) {
      const c = num(r[`c${y}`]);
      if (c === null) {
        warnings.push(`curve ${name} ${r.band}: c${y} missing (row skipped for ${y})`);
        continue;
      }
      curves.push({
        activityKey: key,
        band: r.band,
        year: y,
        m,
        c,
        status,
        sourceUrl: r.sourceUrl ?? defaultSource,
        page,
        note: joinText([r.note, r.printedPage ? `الصفحة المطبوعة ${r.printedPage}` : null, r.cropImage ? `مقتطع: ${r.cropImage}` : null], '؛ '),
      });
    }
  }
  const seen = new Set();
  for (const c of curves) {
    const id = `${c.activityKey}|${c.band}|${c.year}`;
    if (seen.has(id)) errors.push(`duplicate curve ${id}`);
    seen.add(id);
  }
  for (const a of activities.values()) {
    const n = curves.filter((c) => c.activityKey === a.key).length;
    if (n !== BANDS.length * YEARS.length) warnings.push(`activity ${a.nameAr}: ${n} curve rows (expected ${BANDS.length * YEARS.length})`);
  }

  const decisions = [];
  for (const [i, d] of input.decisions.entries()) {
    const group = String(d.groupNameAr ?? '').trim();
    if (!group) {
      errors.push(`decision #${i}: groupNameAr missing`);
      continue;
    }
    const occupations = (Array.isArray(d.occupations) ? d.occupations : [])
      .map((o) => (typeof o === 'string' ? { code: null, nameAr: o, nameEn: null } : { code: o?.code ? String(o.code).trim() : null, nameAr: o?.nameAr ?? null, nameEn: o?.nameEn ?? null }))
      .filter((o) => o.code || o.nameAr || o.nameEn);
    const phases = [];
    for (const p of Array.isArray(d.phases) ? d.phases : []) {
      const pct = num(p?.pct);
      const from = dateOnly(p?.effectiveFrom);
      if (pct === null || pct < 0 || pct > 100 || !from) {
        errors.push(`decision ${group}: invalid phase ${JSON.stringify(p)}`);
        continue;
      }
      const ph = { pct, effectiveFrom: from, ...parseAppliesTo(p.appliesTo) };
      if (p.activity) ph.activity = String(p.activity);
      if (Array.isArray(p.activityCodes) && p.activityCodes.length) ph.activityCodes = p.activityCodes.map(String);
      if (p.appliesTo) ph.appliesTo = String(p.appliesTo);
      phases.push(ph);
    }
    if (!phases.length) errors.push(`decision ${group}: no valid phase`);
    if (!occupations.length) warnings.push(`decision ${group}: no occupations`);
    const wage = minWageOf(d.minWage);
    if (wage.value === null) warnings.push(`decision ${group}: minimum wage unknown${d.minWageStatus ? ` (${d.minWageStatus})` : ''}`);
    const decisionNo = d.decisionNo ? String(d.decisionNo).trim() : null;
    const sourceFile = d.sourceFile ? bareFile(d.sourceFile) : null;
    const notes = joinText([
      d.note,
      wage.note,
      d.minWageStatus ? `الحد الأدنى للأجر: ${d.minWageStatus}` : null,
      d.minEstablishmentSizeNote ? `حجم المنشأة: ${d.minEstablishmentSizeNote}` : null,
      Array.isArray(d.otherConditions) && d.otherConditions.length ? `شروط أخرى: ${d.otherConditions.join(' | ')}` : null,
      d.rounding ? `التقريب: ${d.rounding}` : null,
      d.calculationLevel ? `مستوى الاحتساب: ${d.calculationLevel}` : null,
      d.gracePeriod ? `المهلة: ${d.gracePeriod}` : null,
      d.groupNameEn ? `الاسم بالإنجليزية: ${d.groupNameEn}` : null,
      sourceFile ? `ملف المصدر: ${sourceFile}` : null,
      d.page !== undefined && d.page !== null ? `الصفحات: ${d.page}` : null,
    ], '\n');
    decisions.push({
      id: `${prefix}loc-${slug(group)}${decisionNo ? `-${slug(decisionNo)}` : ''}`,
      groupNameAr: group,
      occupationsJson: JSON.stringify(occupations),
      phasesJson: JSON.stringify(phases),
      minEstablishmentSize: Number.isInteger(num(d.minEstablishmentSize)) ? num(d.minEstablishmentSize) : null,
      minWage: wage.value,
      scope: d.scope ? String(d.scope) : null,
      decisionNo,
      decisionDate: dateOnly(d.decisionDate),
      status: ['VERIFIED_PRIMARY', 'PARTIAL', 'PROVISIONAL', 'USER_INPUT', 'AMBIGUOUS'].includes(String(d.status ?? '').toUpperCase()) ? String(d.status).toUpperCase() : 'PROVISIONAL',
      sourceUrl: isUrl(d.sourceUrl) ? d.sourceUrl.trim() : sourceFile ? (input.sourceFiles?.[sourceFile] ?? null) : null,
      page: firstInt(d.page),
      notes,
    });
  }
  const ids = new Set();
  for (const d of decisions) {
    if (ids.has(d.id)) errors.push(`duplicate decision id ${d.id}`);
    ids.add(d.id);
  }
  return { activities: [...activities.values()], curves, decisions, errors, warnings };
}

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] instanceof Date ? o[k].toISOString().slice(0, 10) : (o[k] ?? null)]));
const ACT_FIELDS = ['nameAr', 'code', 'sizeSegment', 'status', 'sourceUrl', 'page', 'notes'];
const CURVE_FIELDS = ['m', 'c', 'status', 'sourceUrl', 'page', 'note'];
const DEC_FIELDS = ['groupNameAr', 'occupationsJson', 'phasesJson', 'minEstablishmentSize', 'minWage', 'scope', 'decisionNo', 'decisionDate', 'status', 'sourceUrl', 'page', 'notes'];

/** Fields whose stored value differs from the planned one: [{field, db, file}] (empty = unchanged). */
export function diffFields(cur, planned, fields) {
  const a = pick(cur, fields);
  const b = pick(planned, fields);
  return fields.filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f])).map((f) => ({ field: f, db: a[f], file: b[f] }));
}

const short = (v) => {
  const t = JSON.stringify(v);
  return t.length > 90 ? `${t.slice(0, 87)}...` : t;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const docs = args.files.map((f) => {
    const p = path.resolve(f);
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
    } catch (e) {
      usage(`cannot read ${p}: ${e.message}`);
    }
  });
  const plan = buildPlan(classifyInputs(docs), { keyPrefix: args.keyPrefix, sourceUrl: args.sourceUrl });
  const summary = {
    mode: args.apply ? (args.forceUpdate ? 'apply --force-update' : 'apply') : args.noDb ? 'dry-run (no db)' : 'dry-run',
    input: args.canonical ? 'canonical (prisma/data/nitaqat-2026)' : 'files',
    files: args.files.map((f) => path.basename(f)),
    keyPrefix: args.keyPrefix,
    activities: { total: plan.activities.length, create: 0, differs: 0, update: 0, unchanged: 0, verified: plan.activities.filter((a) => a.status === 'VERIFIED_PRIMARY').length, ambiguous: plan.activities.filter((a) => a.status === 'AMBIGUOUS').length },
    curves: { total: plan.curves.length, create: 0, differs: 0, update: 0, unchanged: 0 },
    decisions: { total: plan.decisions.length, create: 0, differs: 0, update: 0, unchanged: 0 },
    /** Existing rows that differ from the files: [{table, id, fields: [{field, db, file}], updated}]. */
    differences: [],
    errors: plan.errors,
    warnings: plan.warnings,
    keys: plan.activities.map((a) => ({ key: a.key, code: a.code, status: a.status })),
    decisionIds: plan.decisions.map((d) => d.id),
  };
  if (plan.errors.length) {
    output(summary, args);
    process.exit(1);
  }
  if (args.noDb) {
    summary.activities.create = plan.activities.length;
    summary.curves.create = plan.curves.length;
    summary.decisions.create = plan.decisions.length;
    output(summary, args);
    return;
  }

  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient(args.databaseUrl ? { datasourceUrl: args.databaseUrl } : undefined);
  try {
    const [acts, curves, decs] = await Promise.all([
      prisma.nitaqatActivity.findMany({ where: { key: { in: plan.activities.map((a) => a.key) } } }),
      prisma.nitaqatCurve.findMany({ where: { activityKey: { in: plan.activities.map((a) => a.key) } } }),
      prisma.localizationDecision.findMany({ where: { id: { in: plan.decisions.map((d) => d.id) } } }),
    ]);
    const actBy = new Map(acts.map((a) => [a.key, a]));
    const curveBy = new Map(curves.map((c) => [`${c.activityKey}|${c.band}|${c.year}`, c]));
    const decBy = new Map(decs.map((d) => [d.id, d]));
    const ops = [];
    /** Existing row: unchanged, or reported (rewritten only with --force-update). Returns true to write. */
    const existing = (table, id, cur, planned, fields) => {
      const fieldsDiff = diffFields(cur, planned, fields);
      if (!fieldsDiff.length) {
        summary[table].unchanged++;
        return false;
      }
      summary[table].differs++;
      if (args.forceUpdate) summary[table].update++;
      summary.differences.push({ table, id, fields: fieldsDiff, updated: args.forceUpdate && args.apply });
      return args.forceUpdate;
    };
    for (const a of plan.activities) {
      const cur = actBy.get(a.key);
      const data = pick(a, ACT_FIELDS);
      if (!cur) {
        summary.activities.create++;
        ops.push(prisma.nitaqatActivity.create({ data: { key: a.key, ...data } }));
      } else if (existing('activities', a.key, cur, a, ACT_FIELDS)) ops.push(prisma.nitaqatActivity.update({ where: { key: a.key }, data }));
    }
    for (const c of plan.curves) {
      const id = `${c.activityKey}|${c.band}|${c.year}`;
      const cur = curveBy.get(id);
      const data = pick(c, CURVE_FIELDS);
      if (!cur) {
        summary.curves.create++;
        ops.push(prisma.nitaqatCurve.create({ data: { activityKey: c.activityKey, band: c.band, year: c.year, ...data } }));
      } else if (existing('curves', id, cur, c, CURVE_FIELDS)) ops.push(prisma.nitaqatCurve.update({ where: { id: cur.id }, data }));
    }
    for (const d of plan.decisions) {
      const cur = decBy.get(d.id);
      const data = { ...pick(d, DEC_FIELDS), decisionDate: d.decisionDate ? new Date(`${d.decisionDate}T00:00:00.000Z`) : null };
      if (!cur) {
        summary.decisions.create++;
        ops.push(prisma.localizationDecision.create({ data: { id: d.id, ...data } }));
      } else if (existing('decisions', d.id, cur, d, DEC_FIELDS)) ops.push(prisma.localizationDecision.update({ where: { id: d.id }, data }));
    }
    if (args.apply && ops.length) {
      // Activities first (curves reference them): the array order is kept inside the transaction.
      await prisma.$transaction(ops);
    }
    summary.written = args.apply ? ops.length : 0;
    output(summary, args);
  } finally {
    await prisma.$disconnect();
  }
}

function output(summary, args) {
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`seed-nitaqat: ${summary.mode}; input ${summary.input}: ${summary.files.join(', ')}${summary.keyPrefix ? ` (prefix ${summary.keyPrefix})` : ''}`);
  for (const k of ['activities', 'curves', 'decisions']) {
    const s = summary[k];
    console.log(`  ${k}: ${s.total} (create ${s.create}, unchanged ${s.unchanged}, differs ${s.differs}, update ${s.update})`);
  }
  for (const d of summary.differences) {
    const tag = d.updated ? 'UPDATED (--force-update)' : args.forceUpdate ? 'DIFFERS (updated with --apply --force-update)' : 'DIFFERS (not changed)';
    console.log(`  ${tag}: ${d.table} ${d.id}`);
    for (const f of d.fields) console.log(`      ${f.field}: ${short(f.db)} -> ${short(f.file)}`);
  }
  if (summary.differences.length && !args.forceUpdate) console.log('  (existing rows are never rewritten by default: the register is immutable; --force-update rewrites them in place, logged)');
  if (summary.written !== undefined) console.log(`  written: ${summary.written}`);
  for (const w of summary.warnings) console.log(`  warning: ${w}`);
  for (const e of summary.errors) console.error(`  ERROR: ${e}`);
  if (!summary.mode.startsWith('apply')) console.log('  (dry-run: nothing written; pass --apply to write)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
