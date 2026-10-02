// Source loading for the architecture conformance tests: parses every file once with the
// TypeScript Compiler API (syntax only, no type checker, so the whole repo parses in ~1-2 s),
// resolves imports between repo files and reads prisma/schema.prisma and the migrations.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';
import { LEGACY_PATH_MODULES } from './config';

export type FileKind = 'src' | 'test' | 'script';

export interface SourceInfo {
  /** Repo-relative path with '/'. */
  path: string;
  kind: FileKind;
  sf: ts.SourceFile;
  /** Owning module (src/modules/<m>/… or LEGACY_PATH_MODULES), null when none. */
  module: string | null;
  /** True for files under src/modules/. */
  inModules: boolean;
}

export interface SchemaField {
  name: string;
  type: string;
  optional: boolean;
  line: number;
  isList: boolean;
  attrs: string;
}
export interface SchemaModel {
  name: string;
  line: number;
  fields: Map<string, SchemaField>;
  blockAttrs: string[];
}
export interface Schema {
  models: Map<string, SchemaModel>;
  enums: Set<string>;
}

export interface Project {
  files: SourceInfo[];
  byPath: Map<string, SourceInfo>;
  schema: Schema;
  /** Concatenated migration SQL, per migration file path. */
  migrations: Map<string, string>;
  /** DOMAIN_BOUNDARIES.md text (for the ownership table). */
  boundariesDoc: string;
  /** Files that exist on disk (or in the fixture) — for existence checks like ARCH-018. */
  exists: (path: string) => boolean;
  readText: (path: string) => string | null;
}

export const ROOT = join(__dirname, '..', '..', '..');

// ---------------------------------------------------------------------------------------------
// Module assignment

export function moduleOf(path: string): { module: string | null; inModules: boolean } {
  const m = /^src\/modules\/([^/]+)\//.exec(path);
  if (m) return { module: m[1], inModules: true };
  let best: string | null = null;
  let bestLen = -1;
  let hit = false;
  // Pages use the segment map of the API (src/app/<seg> ~ src/app/api/<seg>).
  const candidates = [path];
  if (path.startsWith('src/app/') && !path.startsWith('src/app/api/')) candidates.push('src/app/api/' + path.slice('src/app/'.length));
  for (const p of candidates) {
    for (const [prefix, mod] of Object.entries(LEGACY_PATH_MODULES)) {
      if (p.startsWith(prefix) && prefix.length > bestLen) {
        best = mod;
        bestLen = prefix.length;
        hit = true;
      }
    }
  }
  return { module: hit ? best : null, inModules: false };
}

// ---------------------------------------------------------------------------------------------
// Parsing

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

export function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
}

function kindOf(path: string): FileKind {
  if (path.startsWith('scripts/')) return 'script';
  if (/(^|\/)__tests__\//.test(path) || /\.test\.tsx?$/.test(path) || path.startsWith('src/test/')) return 'test';
  return 'src';
}

export function makeSourceInfo(path: string, text: string): SourceInfo {
  const where = moduleOf(path);
  return { path, kind: kindOf(path), sf: parse(path, text), module: where.module, inModules: where.inModules };
}

// ---------------------------------------------------------------------------------------------
// Schema

export function parseSchema(text: string): Schema {
  const models = new Map<string, SchemaModel>();
  const enums = new Set<string>();
  const lines = text.split(/\r?\n/);
  let current: SchemaModel | null = null;
  lines.forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, '').trim();
    const head = /^(model|enum)\s+(\w+)\s*\{/.exec(line);
    if (head) {
      if (head[1] === 'enum') {
        enums.add(head[2]);
        current = null;
      } else {
        current = { name: head[2], line: i + 1, fields: new Map(), blockAttrs: [] };
        models.set(head[2], current);
      }
      return;
    }
    if (line === '}') {
      current = null;
      return;
    }
    if (!current || !line) return;
    if (line.startsWith('@@')) {
      current.blockAttrs.push(line);
      return;
    }
    const f = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
    if (f) current.fields.set(f[1], { name: f[1], type: f[2], isList: !!f[3], optional: !!f[4], line: i + 1, attrs: f[5] });
  });
  return { models, enums };
}

/** lowerCamel accessor on the Prisma client: EmployeeChangeOrder -> employeeChangeOrder. */
export function accessorOf(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

// ---------------------------------------------------------------------------------------------
// Disk project

function walk(dir: string, out: string[], exts: RegExp) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out, exts);
    else if (exts.test(name)) out.push(full);
  }
}

function rel(full: string): string {
  return full.slice(ROOT.length + 1).split('\\').join('/');
}

let cached: Project | null = null;

/** The repository as it is on disk. Parsed once per test worker. */
export function loadProject(): Project {
  if (cached) return cached;
  const paths: string[] = [];
  walk(join(ROOT, 'src'), paths, /\.(ts|tsx)$/);
  walk(join(ROOT, 'scripts'), paths, /\.(mjs|js|ts)$/);
  const files = paths.map((full) => makeSourceInfo(rel(full), readFileSync(full, 'utf8')));
  const migrations = new Map<string, string>();
  const migDir = join(ROOT, 'prisma', 'migrations');
  if (existsSync(migDir)) {
    for (const d of readdirSync(migDir)) {
      const f = join(migDir, d, 'migration.sql');
      if (existsSync(f)) migrations.set(`prisma/migrations/${d}/migration.sql`, readFileSync(f, 'utf8'));
    }
  }
  cached = buildProject(files, readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8'), migrations, readFileSync(join(ROOT, 'docs', 'architecture', 'DOMAIN_BOUNDARIES.md'), 'utf8'), {
    exists: (p) => existsSync(join(ROOT, p)),
    readText: (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : null),
  });
  return cached;
}

export function buildProject(
  files: SourceInfo[],
  schemaText: string,
  migrations: Map<string, string>,
  boundariesDoc: string,
  io?: { exists: (p: string) => boolean; readText: (p: string) => string | null },
): Project {
  const byPath = new Map(files.map((f) => [f.path, f]));
  return {
    files,
    byPath,
    schema: parseSchema(schemaText),
    migrations,
    boundariesDoc,
    exists: io?.exists ?? ((p) => byPath.has(p)),
    readText: io?.readText ?? ((p) => byPath.get(p)?.sf.text ?? null),
  };
}

/** In-memory project for rule fixtures. */
export function fixtureProject(
  sources: Record<string, string>,
  schemaText: string,
  opts: { migrations?: Record<string, string>; boundariesDoc?: string } = {},
): Project {
  const files = Object.entries(sources).map(([p, t]) => makeSourceInfo(p, t));
  return buildProject(files, schemaText, new Map(Object.entries(opts.migrations ?? {})), opts.boundariesDoc ?? '');
}

// ---------------------------------------------------------------------------------------------
// Import resolution

const EXTS = ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx', '/index.mjs'];

/** Repo-relative path an import specifier points to, or null for packages / unknown files. */
export function resolveImport(project: Project, fromPath: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = 'src/' + spec.slice(2);
  else if (spec.startsWith('.')) base = posix.normalize(posix.join(posix.dirname(fromPath), spec));
  else return null;
  for (const ext of EXTS) {
    const p = base + ext;
    if (project.byPath.has(p)) return p;
  }
  return null;
}

/** Raw target (without file lookup) of an import specifier; used for paths that may not exist yet. */
export function importTarget(fromPath: string, spec: string): string | null {
  if (spec.startsWith('@/')) return 'src/' + spec.slice(2);
  if (spec.startsWith('.')) return posix.normalize(posix.join(posix.dirname(fromPath), spec));
  return null;
}

export interface ImportRef {
  spec: string;
  node: ts.Node;
  /** Local name -> imported name ('default' / '*' for namespace). */
  bindings: Map<string, string>;
  typeOnly: boolean;
}

/** Static imports, `export … from`, dynamic `import('…')` and `vi.mock('…')` are all returned. */
export function importsOf(sf: ts.SourceFile): ImportRef[] {
  const out: ImportRef[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const bindings = new Map<string, string>();
      const c = n.importClause;
      if (c?.name) bindings.set(c.name.text, 'default');
      if (c?.namedBindings) {
        if (ts.isNamespaceImport(c.namedBindings)) bindings.set(c.namedBindings.name.text, '*');
        else for (const e of c.namedBindings.elements) bindings.set(e.name.text, (e.propertyName ?? e.name).text);
      }
      out.push({ spec: n.moduleSpecifier.text, node: n, bindings, typeOnly: !!c?.isTypeOnly });
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push({ spec: n.moduleSpecifier.text, node: n, bindings: new Map(), typeOnly: n.isTypeOnly });
    } else if (ts.isCallExpression(n) && n.arguments.length > 0 && ts.isStringLiteralLike(n.arguments[0])) {
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword) {
        out.push({ spec: n.arguments[0].text, node: n, bindings: new Map(), typeOnly: false });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Specifiers passed to vi.mock / vi.doMock in a test file. */
export function mockedSpecs(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === 'vi' &&
      (n.expression.name.text === 'mock' || n.expression.name.text === 'doMock') &&
      n.arguments.length > 0 &&
      ts.isStringLiteralLike(n.arguments[0])
    ) {
      out.push(n.arguments[0].text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// ---------------------------------------------------------------------------------------------
// AST helpers

export function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

export function forEachDescendant(node: ts.Node, fn: (n: ts.Node) => void) {
  const visit = (n: ts.Node) => {
    fn(n);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
}

/** Final name of a callee: foo() -> foo, a.b.foo() -> foo. */
export function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

export type WriteOp = 'create' | 'createMany' | 'createManyAndReturn' | 'update' | 'updateMany' | 'upsert' | 'delete' | 'deleteMany';
export const WRITE_OPS = new Set<string>(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']);
export const READ_OPS = new Set<string>(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy']);

export interface ModelCall {
  model: string;
  op: string;
  call: ts.CallExpression;
  line: number;
  write: boolean;
}

/**
 * Calls of the form `<anything>.<modelAccessor>.<op>(…)` where <modelAccessor> is a Prisma model
 * of the schema (prisma.employee.update, tx.leave.create, db.payroll.findMany…).
 */
export function modelCalls(project: Project, info: SourceInfo): ModelCall[] {
  const byAccessor = accessorIndex(project);
  const out: ModelCall[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const op = n.expression.name.text;
      const recv = n.expression.expression;
      if ((WRITE_OPS.has(op) || READ_OPS.has(op)) && ts.isPropertyAccessExpression(recv)) {
        const model = byAccessor.get(recv.name.text);
        if (model) out.push({ model, op, call: n, line: lineOf(info.sf, n), write: WRITE_OPS.has(op) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(info.sf);
  return out;
}

const accessorCache = new WeakMap<Project, Map<string, string>>();
function accessorIndex(project: Project): Map<string, string> {
  let m = accessorCache.get(project);
  if (!m) {
    m = new Map([...project.schema.models.keys()].map((k) => [accessorOf(k), k]));
    accessorCache.set(project, m);
  }
  return m;
}

/** Top-level keys of the `data` (and upsert `create`/`update`) object literal of a write call. */
export function writtenKeys(call: ts.CallExpression): { keys: Set<string>; opaque: boolean } {
  const keys = new Set<string>();
  let opaque = false;
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return { keys, opaque: true };
  const collect = (obj: ts.Expression) => {
    if (ts.isArrayLiteralExpression(obj)) {
      obj.elements.forEach((e) => collect(e));
      return;
    }
    if (!ts.isObjectLiteralExpression(obj)) {
      opaque = true;
      return;
    }
    for (const p of obj.properties) {
      if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
        const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
        if (name) keys.add(name);
      } else if (ts.isSpreadAssignment(p)) {
        opaque = true;
      }
    }
  };
  for (const p of arg.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
    if (['data', 'create', 'update'].includes(p.name.text)) collect(p.initializer);
  }
  return { keys, opaque };
}

/** `$transaction(cb)` / `$transaction([...])` calls with their callback (if any). */
export function transactionCalls(sf: ts.SourceFile): { call: ts.CallExpression; body: ts.Node | null; array: ts.Expression | null }[] {
  const out: { call: ts.CallExpression; body: ts.Node | null; array: ts.Expression | null }[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === '$transaction') {
      const a = n.arguments[0];
      if (a && (ts.isArrowFunction(a) || ts.isFunctionExpression(a))) out.push({ call: n, body: a.body, array: null });
      else if (a) out.push({ call: n, body: null, array: a });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Function index + transitive "taint" (a function that calls X, directly or through other
// functions of the repo resolved by import). Used for guards (ARCH-016) and side effects (ARCH-017).

interface FnDecl {
  file: string;
  name: string;
  body: ts.Node;
}

function topLevelFunctions(info: SourceInfo): FnDecl[] {
  const out: FnDecl[] = [];
  for (const st of info.sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) out.push({ file: info.path, name: st.name.text, body: st });
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) {
          let init: ts.Expression = d.initializer;
          // cache(async () => …) and similar single-argument wrappers
          if (ts.isCallExpression(init) && init.arguments.length === 1) init = init.arguments[0];
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) out.push({ file: info.path, name: d.name.text, body: init });
        }
      }
    }
  }
  return out;
}

/** An identifier used as a value handed to someone else: a call argument or a default parameter. */
function isValuePosition(n: ts.Identifier): boolean {
  const p = n.parent;
  if (ts.isCallExpression(p)) return p.arguments.some((a) => a === n);
  if (ts.isParameter(p)) return p.initializer === n;
  return false;
}

export interface Taint {
  /** Does evaluating `node` (in file) call a tainted function? */
  reaches: (file: string, node: ts.Node) => boolean;
  /** Names of the tainted calls found inside node (for messages). */
  hits: (file: string, node: ts.Node) => string[];
}

interface Ref {
  /** Called name (seed match); null for a function passed as a value. */
  call: string | null;
  /** Repo declaration it resolves to (file#name), if any. */
  key: string | null;
}

interface CallGraph {
  decls: Map<string, Ref[]>;
  refsOf: (file: string, node: ts.Node) => Ref[];
}

const graphCache = new WeakMap<Project, CallGraph>();

/** Seed-independent call graph of the repo's top-level functions, built once per project. */
function callGraph(project: Project): CallGraph {
  const hit = graphCache.get(project);
  if (hit) return hit;
  const files = project.files.filter((f) => f.kind !== 'test');
  const declNodes = new Map<string, FnDecl>(); // key file#name
  const importMaps = new Map<string, Map<string, { file: string; name: string }>>();
  for (const f of files) {
    for (const d of topLevelFunctions(f)) declNodes.set(`${f.path}#${d.name}`, d);
    const m = new Map<string, { file: string; name: string }>();
    for (const imp of importsOf(f.sf)) {
      const target = resolveImport(project, f.path, imp.spec);
      if (!target) continue;
      for (const [local, imported] of imp.bindings) m.set(local, { file: target, name: imported });
    }
    importMaps.set(f.path, m);
  }
  // Follow `export { x } from './y'` one level for barrels.
  const reexports = new Map<string, { file: string; name: string }>();
  for (const f of files) {
    for (const st of f.sf.statements) {
      if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && st.exportClause && ts.isNamedExports(st.exportClause)) {
        const target = resolveImport(project, f.path, st.moduleSpecifier.text);
        if (!target) continue;
        for (const e of st.exportClause.elements) reexports.set(`${f.path}#${e.name.text}`, { file: target, name: (e.propertyName ?? e.name).text });
      }
    }
  }
  const resolve = (file: string, name: string): string | null => {
    let key: string | null = declNodes.has(`${file}#${name}`) ? `${file}#${name}` : null;
    if (!key) {
      const imp = importMaps.get(file)?.get(name);
      if (imp) {
        key = `${imp.file}#${imp.name}`;
        const re = reexports.get(key);
        if (re) key = `${re.file}#${re.name}`;
      }
    }
    return key && declNodes.has(key) ? key : null;
  };
  const refsOf = (file: string, node: ts.Node): Ref[] => {
    const out: Ref[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const name = calleeName(n);
        if (name) out.push({ call: name, key: ts.isIdentifier(n.expression) ? resolve(file, name) : null });
      } else if (ts.isIdentifier(n) && isValuePosition(n)) {
        // A function passed as a value (default parameter, callback) counts as called.
        const key = resolve(file, n.text);
        if (key) out.push({ call: null, key });
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return out;
  };
  const decls = new Map<string, Ref[]>();
  for (const [key, d] of declNodes) decls.set(key, refsOf(d.file, d.body));
  const g = { decls, refsOf };
  graphCache.set(project, g);
  return g;
}

export function computeTaint(project: Project, seeds: readonly string[]): Taint {
  const seedSet = new Set(seeds);
  const g = callGraph(project);
  const callers = new Map<string, string[]>();
  const tainted = new Set<string>();
  const queue: string[] = [];
  for (const [key, refs] of g.decls) {
    for (const r of refs) {
      if (r.key) {
        const arr = callers.get(r.key);
        if (arr) arr.push(key);
        else callers.set(r.key, [key]);
      }
      if (r.call && seedSet.has(r.call) && !tainted.has(key)) {
        tainted.add(key);
        queue.push(key);
      }
    }
  }
  while (queue.length) {
    const k = queue.pop()!;
    for (const c of callers.get(k) ?? []) {
      if (!tainted.has(c)) {
        tainted.add(c);
        queue.push(c);
      }
    }
  }
  const hits = (file: string, node: ts.Node) =>
    g.refsOf(file, node).filter((r) => (r.call && seedSet.has(r.call)) || (r.key && tainted.has(r.key))).map((r) => r.call ?? r.key!.split('#')[1]);
  return {
    reaches: (file, node) => hits(file, node).length > 0,
    hits: (file, node) => [...new Set(hits(file, node))],
  };
}
