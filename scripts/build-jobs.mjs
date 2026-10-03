#!/usr/bin/env node
// Builds the background-job runner (P1-FND-JOBS, DEC-PO-121) from the modules' own TypeScript code
// into ONE CommonJS file, dist/jobs/jobs.cjs, that plain `node` runs (scripts/jobs.mjs loads it), and the
// same way Radeef's vendor CLI (BL-PAY-017 / BL-PAY-022: src/modules/iam/vendor-cli.ts -> dist/vendor/vendor.cjs, loaded by
// scripts/vendor.mjs, run by radeef-manage over SSH).
// Tooling only: no business rule and no database access here (ARCH-008).
//
//   node scripts/build-jobs.mjs [--out <dir>]      (npm run build:jobs; part of npm run build)
//
// Why a bundle: the Docker runtime image ships the Next standalone server, not src/ nor the full
// node_modules, and plain node cannot import TypeScript or the "@/…" path alias. The TypeScript
// compiler (already a devDependency) transpiles every file reachable from src/jobs/cli.ts, one file
// at a time (isolatedModules), and this script links them into a module map with a tiny CommonJS
// loader. Packages stay real `require`s and must be in ALLOWED_PACKAGES: the Dockerfile copies
// exactly these into the runtime image, so a job that pulls in another package (e.g. next/server
// through a careless import) fails the build here instead of failing at 3 a.m. in production.
import { builtinModules } from 'node:module';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENTRY = 'src/jobs/cli.ts';
export const VENDOR_ENTRY = 'src/modules/iam/vendor-cli.ts';
/** Packages the bundle may require at run time (Dockerfile runner stage: keep in sync). */
/** zod and nodemailer have no dependencies of their own; @prisma/client needs the generated .prisma/client. */
export const ALLOWED_PACKAGES = ['@prisma/client', 'nodemailer', 'zod'];
/** Imports that are compile-time markers only and are replaced by an empty module. */
const EMPTY_MODULES = ['server-only'];
/**
 * Packages replaced by a repo file inside the bundle. next/server: jobs never answer HTTP, but
 * src/lib/http.ts (loaded through iam and platform) imports NextResponse at load time, and the
 * runtime image has no `next/server` entry (see src/jobs/next-server-shim.ts).
 */
const SHIMS = { 'next/server': 'src/jobs/next-server-shim.ts' };
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.json'];
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

const COMPILER_OPTIONS = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  esModuleInterop: true,
  allowJs: true,
  isolatedModules: true,
  jsx: ts.JsxEmit.ReactJSX,
  sourceMap: false,
  removeComments: false,
};

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Repo-relative module id ("src/lib/prisma.ts") for a specifier, or null for a package. */
function resolveRepo(spec, fromId) {
  let base;
  if (spec.startsWith('@/')) base = path.join(ROOT, 'src', spec.slice(2));
  else if (spec.startsWith('./') || spec.startsWith('../')) base = path.resolve(ROOT, path.dirname(fromId), spec);
  else return null;
  const candidates = [base, ...EXTENSIONS.map((e) => base + e), ...EXTENSIONS.map((e) => path.join(base, 'index' + e))];
  const hit = candidates.find(isFile);
  if (!hit) throw new Error(`cannot resolve "${spec}" imported by ${fromId}`);
  return path.relative(ROOT, hit).split(path.sep).join('/');
}

function packageName(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// TypeScript keeps the quote style of the source: require("x") or require('x').
const REQUIRE_RE = /\brequire\((["'])([^"']+)\1\)/g;

export function buildJobsBundle({ entry = ENTRY, allowed = ALLOWED_PACKAGES } = {}) {
  const modules = new Map(); // id -> { code, deps }
  const externals = new Map(); // package -> first importer
  const queue = [entry];
  while (queue.length) {
    const id = queue.shift();
    if (modules.has(id)) continue;
    const abs = path.join(ROOT, id);
    const source = readFileSync(abs, 'utf8');
    let code;
    if (id.endsWith('.json')) {
      code = `module.exports = ${JSON.stringify(JSON.parse(source))};`;
    } else {
      // Transpile as .ts / .js so that .mts / .mjs sources become CommonJS too.
      const fileName = /\.(mjs|cjs|js)$/.test(id) ? id.replace(/\.(mjs|cjs)$/, '.js') : id.replace(/\.mts$/, '.ts');
      const out = ts.transpileModule(source, { fileName, compilerOptions: COMPILER_OPTIONS, reportDiagnostics: true });
      const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
      if (errors.length) throw new Error(`${id}: ${ts.flattenDiagnosticMessageText(errors[0].messageText, '\n')}`);
      code = out.outputText;
      if (/\bimport\.meta\b/.test(code)) throw new Error(`${id}: import.meta is not available in the CommonJS job bundle`);
    }
    const deps = {};
    for (const m of code.matchAll(REQUIRE_RE)) {
      const spec = m[2];
      if (spec in deps) continue;
      if (EMPTY_MODULES.includes(spec)) {
        deps[spec] = null;
        continue;
      }
      const target = SHIMS[spec] ?? resolveRepo(spec, id);
      if (target) {
        deps[spec] = target;
        queue.push(target);
        continue;
      }
      if (BUILTINS.has(spec)) continue;
      const pkg = packageName(spec);
      if (!externals.has(pkg)) externals.set(pkg, id);
    }
    modules.set(id, { code, deps });
  }

  const refused = [...externals].filter(([pkg]) => !allowed.includes(pkg));
  if (refused.length) {
    throw new Error(
      'the job bundle requires packages the runtime image does not ship:\n' +
        refused.map(([pkg, from]) => `  - ${pkg} (first imported by ${from})`).join('\n') +
        `\nAllowed: ${allowed.join(', ')}. Import a lighter module, or add the package to ALLOWED_PACKAGES in scripts/build-jobs.mjs AND to the runner stage of the Dockerfile.`,
    );
  }

  const ids = [...modules.keys()].sort();
  const body = ids
    .map((id) => {
      const { code, deps } = modules.get(id);
      return `[${JSON.stringify(id)}, ${JSON.stringify(deps)}, function (exports, require, module, __filename, __dirname) {\n${code}\n}]`;
    })
    .join(',\n');
  const bundle = `'use strict';
// GENERATED by scripts/build-jobs.mjs from ${entry} — do not edit. Rebuild: npm run build:jobs
const __path = require('node:path');
const __defs = new Map([
${body}
].map((d) => [d[0], d]));
const __cache = new Map();
function __load(id) {
  const cached = __cache.get(id);
  if (cached) return cached.exports;
  const def = __defs.get(id);
  if (!def) throw new Error('job bundle: unknown module ' + id);
  const module = { exports: {} };
  __cache.set(id, module);
  const deps = def[1];
  const req = (spec) => {
    if (Object.prototype.hasOwnProperty.call(deps, spec)) return deps[spec] === null ? {} : __load(deps[spec]);
    return require(spec);
  };
  const file = __path.join(process.cwd(), id);
  def[2].call(module.exports, module.exports, req, module, file, __path.dirname(file));
  return module.exports;
}
module.exports = __load(${JSON.stringify(entry)});
`;
  new vm.Script(bundle, { filename: 'jobs.cjs' }); // syntax check (throws on error)
  return { bundle, modules: ids, externals: [...externals.keys()].sort() };
}

function writeBundle(entry, outDir, file) {
  const started = Date.now();
  const { bundle, modules, externals } = buildJobsBundle({ entry });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, file), bundle);
  writeFileSync(
    path.join(outDir, 'manifest.json'),
    JSON.stringify({ entry, builtAt: new Date().toISOString(), externals, modules }, null, 1) + '\n',
  );
  console.log(`[build-jobs] ${modules.length} modules -> ${path.relative(ROOT, outDir)}/${file} (${Math.round(bundle.length / 1024)} KB, packages: ${externals.join(', ') || 'none'}) in ${Date.now() - started} ms`);
}

function main(argv) {
  const outIdx = argv.indexOf('--out');
  const outDir = path.resolve(ROOT, outIdx >= 0 ? argv[outIdx + 1] : 'dist/jobs');
  writeBundle(ENTRY, outDir, 'jobs.cjs');
  writeBundle(VENDOR_ENTRY, path.resolve(outDir, '..', 'vendor'), 'vendor.cjs');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    for (const e of [ENTRY, VENDOR_ENTRY]) if (!existsSync(path.join(ROOT, e))) throw new Error(`${e} not found`);
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`[build-jobs] FAILED: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
