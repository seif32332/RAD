// The ARCH-001..021 checks (ARCHITECTURE_INVARIANTS §4.1.1). Each rule is a pure function of the
// parsed project and returns its violations; the ratchet (ratchet.ts) compares them with the
// baseline. Heuristic limits are stated in each rule's `check` text, which is also the test title
// context when a rule fails.
import ts from 'typescript';
import {
  AUTH_GUARDS,
  EMPLOYEE_MONEY_FIELDS,
  EMPLOYEE_PROJECTIONS,
  EMPLOYMENT_STATE_FIELDS,
  EMPLOYMENT_STATE_MODELS,
  FINANCIAL_CALC_MODULES,
  LEGAL_CONTEXT,
  LEGAL_NUMBERS,
  LEGAL_SCAN_EXEMPT,
  MODULE_LAYERS,
  MONEY_ARITH_INTEGERS,
  MONEY_MODELS,
  MONEY_MODULES,
  OWNERSHIP_SUPPLEMENT,
  PERIOD_KIND_OWNERS,
  PERIOD_WRITERS,
  PROJECTED_SALARY_FIELDS,
  PUBLIC_ROUTES,
  SCOPE_MARKERS,
  SCRIPT_WRITE_ALLOWLIST,
  SIDE_EFFECT_CALLS,
  STATE_NAME_EXEMPT,
  WORKFLOW_ALLOWED_DEPS,
  WORKFLOW_MODULE,
} from './config';
import {
  type ModelCall,
  type Project,
  type SourceInfo,
  calleeName,
  computeTaint,
  forEachDescendant,
  importTarget,
  importsOf,
  lineOf,
  mockedSpecs,
  modelCalls,
  moduleOf,
  resolveImport,
  transactionCalls,
  writtenKeys,
} from './source';

export interface Violation {
  rule: string;
  /** Ratchet key: the file (or schema.prisma#Model[.field]) the violation is counted against. */
  key: string;
  line: number;
  message: string;
  /** Optional tag an ADR allowance can match (baseline.json "allowances"). */
  tag?: string;
}

export interface Rule {
  id: string;
  title: string;
  /** What is checked mechanically, and its limits. */
  check: string;
  /** What to do when the rule fails. */
  fix: string;
  run: (p: Project) => Violation[];
}

// ---------------------------------------------------------------------------------------------
// Shared facts

/** Model -> owning module, parsed from DOMAIN_BOUNDARIES §5.2 (+ OWNERSHIP_SUPPLEMENT). */
export function ownership(p: Project): { owners: Map<string, string>; conflicts: string[] } {
  const owners = new Map<string, string>();
  const conflicts: string[] = [];
  const section = /##\s*5\.2[\s\S]*?(?=\n##\s)/.exec(p.boundariesDoc)?.[0] ?? '';
  for (const row of section.split('\n')) {
    const m = /^\|\s*\*\*([a-z]+)\*\*\s*\|(.*)$/.exec(row.trim());
    if (!m) continue;
    const owner = m[1];
    // Names inside parentheses are commentary ("(يصبح PayrollLine)", "(الإسقاطات على Employee …)").
    const cols = m[2].replace(/\([^)]*\)/g, ' ');
    for (const name of cols.match(/\b[A-Z][a-z][A-Za-z0-9]*\b/g) ?? []) {
      const prev = owners.get(name);
      if (prev && prev !== owner) conflicts.push(`${name}: ${prev} and ${owner}`);
      else owners.set(name, owner);
    }
  }
  for (const [k, v] of Object.entries(OWNERSHIP_SUPPLEMENT)) if (!owners.has(k)) owners.set(k, v);
  return { owners, conflicts };
}

const ownersCache = new WeakMap<Project, Map<string, string>>();
function ownerOf(p: Project, model: string): string | undefined {
  let o = ownersCache.get(p);
  if (!o) {
    o = ownership(p).owners;
    ownersCache.set(p, o);
  }
  return o.get(model);
}

const callsCache = new WeakMap<Project, Map<string, ModelCall[]>>();
function callsOf(p: Project, f: SourceInfo): ModelCall[] {
  let c = callsCache.get(p);
  if (!c) {
    c = new Map();
    callsCache.set(p, c);
  }
  let v = c.get(f.path);
  if (!v) {
    v = modelCalls(p, f);
    c.set(f.path, v);
  }
  return v;
}

const code = (p: Project) => p.files.filter((f) => f.kind === 'src');
const codeAndScripts = (p: Project) => p.files.filter((f) => f.kind !== 'test');

function isTransitionFile(path: string, module: string): boolean {
  return path === `src/modules/${module}/transitions.ts` || path.startsWith(`src/modules/${module}/transitions/`);
}

function employeeKeyed(p: Project, model: string): boolean {
  return model === 'Employee' || !!p.schema.models.get(model)?.fields.has('employeeId');
}

function companyScoped(p: Project, model: string): boolean {
  const m = p.schema.models.get(model);
  if (!m) return false;
  // platform / iam tables are cross-company infrastructure (outbox, audit, users: §5.4.2 SystemContext).
  const owner = ownerOf(p, model);
  if (owner === 'platform' || owner === 'iam') return false;
  return model === 'Employee' || ['companyId', 'legalCompanyId', 'actualCompanyId', 'employeeId'].some((f) => m.fields.has(f));
}

function periodModels(p: Project): Set<string> {
  const out = new Set(['CompensationPeriod', 'AssignmentPeriod', 'EmploymentPeriod', 'ContractPeriod', 'BankIdentityPeriod', 'GosiRegistrationPeriod']);
  for (const m of p.schema.models.values()) if (m.fields.has('validFrom') && m.fields.has('validTo')) out.add(m.name);
  return out;
}

function schemaKey(model: string, field?: string) {
  return `prisma/schema.prisma#${model}${field ? '.' + field : ''}`;
}

function v(rule: string, f: SourceInfo, line: number, message: string, tag?: string): Violation {
  return { rule, key: f.path, line, message, tag };
}

// ---------------------------------------------------------------------------------------------
// Rules

const ARCH_001: Rule = {
  id: 'ARCH-001',
  title: 'a module reads another module only through its public interface',
  check:
    'Imports into src/modules/<m>/ from outside <m> must target src/modules/<m>/index (deep imports refused; also enforced by ESLint no-restricted-imports). ' +
    'Inside src/modules/<m>/, a Prisma read (find*/count/aggregate/groupBy) on a model owned by another module (§5.2) is a violation. ' +
    'Legacy code (src/lib, src/app) is not checked for reads: it moves into modules package by package (§5.1).',
  fix: 'Import the other module from "@/modules/<m>" (its index.ts) and call a read function it exports; never query its tables.',
  run: (p) => {
    const out: Violation[] = [];
    for (const f of p.files) {
      if (f.kind !== 'src') continue; // tests may reach into the module they test
      for (const imp of importsOf(f.sf)) {
        const target = importTarget(f.path, imp.spec);
        const m = target && /^src\/modules\/([^/]+)(\/(.*))?$/.exec(target);
        if (!m) continue;
        if (f.inModules && f.module === m[1]) continue;
        const rest = (m[3] ?? '').replace(/\.(ts|tsx)$/, '');
        if (rest === '' || rest === 'index') continue;
        out.push(v('ARCH-001', f, lineOf(f.sf, imp.node), `deep import "${imp.spec}" into module ${m[1]}; import "@/modules/${m[1]}" instead`));
      }
      if (!f.inModules || f.kind !== 'src') continue;
      for (const c of callsOf(p, f)) {
        if (c.write) continue;
        const owner = ownerOf(p, c.model);
        if (owner && owner !== f.module) {
          out.push(v('ARCH-001', f, c.line, `module ${f.module} reads ${c.model} (owned by ${owner}) with .${c.op}(); read it through @/modules/${owner}`));
        }
      }
    }
    return out;
  },
};

const ARCH_001_DIR: Rule = {
  id: 'ARCH-001.dir',
  title: 'dependency direction: a module calls only modules below it (§5.3)',
  check:
    'For every non-type import between two files whose modules are known (src/modules/<m>/ or the legacy path map in config.ts), the importer layer must be strictly above the imported one ' +
    '(finance is below payroll, ADR-0002 #7; workflow depends on platform and iam only). Upward calls must become events.',
  fix: 'Call only modules below yours. To react to a module above, consume its DomainEvent instead of importing it.',
  run: (p) => {
    const out: Violation[] = [];
    for (const f of p.files) {
      // Route handlers and pages (src/app) are the application shell above every module (§5.1); only
      // module code is layered: src/modules and the legacy module code in src/lib.
      if (f.kind !== 'src' || !f.module || !/^src\/(lib|modules)\//.test(f.path)) continue;
      for (const imp of importsOf(f.sf)) {
        if (imp.typeOnly) continue;
        const target = resolveImport(p, f.path, imp.spec) ?? importTarget(f.path, imp.spec);
        if (!target || !target.startsWith('src/')) continue;
        const to = moduleOf(target).module;
        if (!to || to === f.module) continue;
        if (to === WORKFLOW_MODULE) continue; // everyone registers adapters with the engine
        if (f.module === WORKFLOW_MODULE) {
          if (!WORKFLOW_ALLOWED_DEPS.includes(to)) out.push(v('ARCH-001.dir', f, lineOf(f.sf, imp.node), `workflow core imports ${to} ("${imp.spec}"); it may depend on platform and iam only`));
          continue;
        }
        const a = MODULE_LAYERS[f.module];
        const b = MODULE_LAYERS[to];
        if (a === undefined || b === undefined) continue;
        if (a <= b) {
          out.push(v('ARCH-001.dir', f, lineOf(f.sf, imp.node), `${f.module} (layer ${a}) imports ${to} (layer ${b}) via "${imp.spec}": ${a === b ? 'same layer' : 'upward'} dependency`));
        }
      }
    }
    return out;
  },
};

const ARCH_002: Rule = {
  id: 'ARCH-002',
  title: 'no module writes a table it does not own (§5.2)',
  check:
    'Every Prisma write (create/createMany/update/updateMany/upsert/delete/deleteMany on <any>.<model>) in src/ must be in the module that owns <model> per DOMAIN_BOUNDARIES §5.2. ' +
    'Writes to Employee that touch only projection columns of the writer are left to ARCH-003. Files without a module (multi-domain legacy) own nothing. ' +
    'Limit: nested relation writes (data: { rows: { create: … } }) are not seen.',
  fix: "Call the owning module's transition function (src/modules/<owner>/transitions.ts) instead of writing its table.",
  run: (p) => {
    const out: Violation[] = [];
    for (const f of code(p)) {
      for (const c of callsOf(p, f).filter((x) => x.write)) {
        const owner = ownerOf(p, c.model);
        if (!owner) continue; // reported by ARCH-002.owner
        if (owner === f.module) continue;
        if (c.model === 'Employee' && f.module) {
          const { keys, opaque } = writtenKeys(c.call);
          if (!opaque && keys.size > 0 && [...keys].every((k) => EMPLOYEE_PROJECTIONS[k] === f.module)) continue;
        }
        out.push(v('ARCH-002', f, c.line, `${f.module ?? 'unassigned legacy code'} writes ${c.model} (.${c.op}) owned by ${owner}`));
      }
    }
    return out;
  },
};

const ARCH_002_OWNER: Rule = {
  id: 'ARCH-002.owner',
  title: 'every Prisma model has exactly one owner in DOMAIN_BOUNDARIES §5.2',
  check: 'Each model of prisma/schema.prisma must appear in the §5.2 ownership table (parsed from the doc), and no model may be listed under two modules.',
  fix: 'Add the model to the §5.2 table (and its SOURCE_OF_TRUTH row) through an ADR before adding it to the schema.',
  run: (p) => {
    const out: Violation[] = [];
    const { conflicts } = ownership(p);
    for (const c of conflicts) out.push({ rule: 'ARCH-002.owner', key: 'docs/architecture/DOMAIN_BOUNDARIES.md', line: 0, message: `model listed under two modules: ${c}` });
    for (const m of p.schema.models.values()) {
      if (!ownerOf(p, m.name)) out.push({ rule: 'ARCH-002.owner', key: schemaKey(m.name), line: m.line, message: `model ${m.name} has no owner in DOMAIN_BOUNDARIES §5.2` });
    }
    return out;
  },
};

const ARCH_003: Rule = {
  id: 'ARCH-003',
  title: 'projections are written by their projector only (SOURCE_OF_TRUTH)',
  check:
    'A write to Employee whose data literal sets a projection column (config EMPLOYEE_PROJECTIONS: state -> lifecycle, salary/bank -> compensation, assignment -> org, GOSI -> payroll, accrual start -> leave, exit -> offboarding) ' +
    'outside the projector module is a violation; so is deriving the state yourself (`x.employmentState ?? …isTerminated…`) outside lifecycle. ' +
    'The fallback inside lifecycle readers is the ADR-0002 #5 allowance. Limit: data built in a variable or spread is not seen.',
  fix: 'Change the fact through the projector (lifecycle.transitionEmploymentState, compensation.applyDecision, org.applyAssignment…); read the state through the lifecycle readers.',
  run: (p) => {
    const out: Violation[] = [];
    for (const f of code(p)) {
      for (const c of callsOf(p, f)) {
        if (!c.write || c.model !== 'Employee') continue;
        const { keys } = writtenKeys(c.call);
        const wrong = [...keys].filter((k) => EMPLOYEE_PROJECTIONS[k] && EMPLOYEE_PROJECTIONS[k] !== f.module);
        if (wrong.length) out.push(v('ARCH-003', f, c.line, `writes projection column(s) ${wrong.map((k) => `${k} (projector ${EMPLOYEE_PROJECTIONS[k]})`).join(', ')}`));
      }
      forEachDescendant(f.sf, (n) => {
        if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
          /\.employmentState$/.test(n.left.getText(f.sf)) &&
          /isTerminated/.test(n.right.getText(f.sf))
        ) {
          out.push(v('ARCH-003', f, lineOf(f.sf, n), 'derives the employment state from isTerminated (BR-LCY-013 fallback); allowed only inside lifecycle readers', 'employment-state-fallback'));
        }
      });
    }
    // The fallback allowance covers only src/modules/lifecycle; anywhere else it stays a violation.
    return out;
  },
};

const ARCH_004: Rule = {
  id: 'ARCH-004',
  title: "money is written only by the owning module's transition, behind money.gateway",
  check:
    'Writes to money tables (config MONEY_MODELS: Payroll, Deduction, Loan, LoanInstallment, Settlement, PaymentRequest, Allowance, SalaryChange and the planned PayrollLine, CompensationPeriod…) ' +
    'and to Employee money columns (basicSalary, gosiDeduction, ibanNumber…) are allowed only in src/modules/<owner>/transitions.ts (or transitions/). ' +
    'Limit: that the transition is registered in money.gateway is enforced at run time (Prisma extension), not here.',
  fix: "Register the operation in money.gateway and write through the owner's transition function.",
  run: (p) => {
    const out: Violation[] = [];
    for (const f of codeAndScripts(p)) {
      if (f.kind === 'script') continue; // scripts: ARCH-008
      for (const c of callsOf(p, f)) {
        if (!c.write) continue;
        if (MONEY_MODELS.includes(c.model)) {
          const owner = ownerOf(p, c.model) ?? '?';
          if (!isTransitionFile(f.path, owner)) out.push(v('ARCH-004', f, c.line, `writes money table ${c.model} (.${c.op}) outside ${owner}/transitions`));
        } else if (c.model === 'Employee') {
          const money = [...writtenKeys(c.call).keys].filter((k) => EMPLOYEE_MONEY_FIELDS.includes(k));
          if (money.length && !isTransitionFile(f.path, 'compensation') && !isTransitionFile(f.path, 'payroll')) {
            out.push(v('ARCH-004', f, c.line, `writes Employee money column(s) ${money.join(', ')} outside compensation/transitions`));
          }
        }
      }
    }
    return out;
  },
};

const ARCH_005: Rule = {
  id: 'ARCH-005',
  title: 'every employment-state change goes through transitionEmploymentState',
  check:
    'A write to Employee that sets employmentState / employmentStatus / isTerminated / terminationDate, or any write to EmploymentStateChange / EmploymentPeriod, ' +
    'is allowed only in src/modules/lifecycle/transitions.ts (or transitions/). Limit: data built in a variable or spread is not seen.',
  fix: 'Call lifecycle.transitionEmploymentState (BR-LCY-006).',
  run: (p) => {
    const out: Violation[] = [];
    for (const f of code(p)) {
      if (isTransitionFile(f.path, 'lifecycle')) continue;
      for (const c of callsOf(p, f)) {
        if (!c.write) continue;
        if (EMPLOYMENT_STATE_MODELS.includes(c.model)) out.push(v('ARCH-005', f, c.line, `writes ${c.model} outside lifecycle/transitions`));
        else if (c.model === 'Employee') {
          const st = [...writtenKeys(c.call).keys].filter((k) => EMPLOYMENT_STATE_FIELDS.includes(k));
          if (st.length) out.push(v('ARCH-005', f, c.line, `sets ${st.join(', ')} directly`));
        }
      }
    }
    return out;
  },
};

const ARCH_006: Rule = {
  id: 'ARCH-006',
  title: 'queries on company-scoped models go through the scope contract (§5.4)',
  check:
    'Closest mechanical check until ScopedContext exists: every non-public API route that queries a company-scoped model (a model with companyId / legalCompanyId / actualCompanyId / employeeId, or Employee) ' +
    'must reach a scope helper (config SCOPE_MARKERS: userCompanyScope, companyScopeWhere, assertCompaniesInScope, staffCompanyScope, requireEmployeeId, ScopedContext…), directly or through a function it calls. ' +
    'The runtime half (two users of two companies per route) is INV-SCOPE-01 / ARCH-016.',
  fix: 'Build the company scope of the actor (userCompanyScope / ScopedContext) and pass it to every query of the route.',
  run: (p) => {
    const out: Violation[] = [];
    const taint = computeTaint(p, SCOPE_MARKERS);
    for (const f of code(p)) {
      if (!/^src\/app\/api\/.*\/route\.ts$/.test(f.path) || PUBLIC_ROUTES.includes(f.path)) continue;
      const scoped = callsOf(p, f).filter((c) => companyScoped(p, c.model));
      if (!scoped.length) continue;
      const marker = SCOPE_MARKERS.some((m) => new RegExp(`\\b${m}\\b`).test(f.sf.text));
      if (marker || taint.reaches(f.path, f.sf)) continue;
      out.push(v('ARCH-006', f, scoped[0].line, `queries ${[...new Set(scoped.map((c) => c.model))].join(', ')} without a company scope`));
    }
    return out;
  },
};

/**
 * The words around a literal: the names of the properties / variables / parameters it is assigned
 * to, the text of its nearest enclosing object literal or statement within ±120 characters of it,
 * and the name of the enclosing function.
 */
function legalContextText(n: ts.Node, sf: ts.SourceFile): string {
  let cur: ts.Node = n;
  const parts: string[] = [];
  let container: ts.Node | null = null;
  while (cur.parent) {
    cur = cur.parent;
    if (ts.isPropertyAssignment(cur) || ts.isVariableDeclaration(cur) || ts.isParameter(cur) || ts.isPropertyDeclaration(cur)) {
      parts.push(cur.name.getText(sf));
    }
    if (!container && ts.isObjectLiteralExpression(cur)) container = cur;
    if (ts.isStatement(cur) && !ts.isBlock(cur)) {
      container ??= cur;
      break;
    }
  }
  if (container) {
    const start = Math.max(container.getStart(sf), n.getStart(sf) - 120);
    const end = Math.min(container.end, n.end + 120);
    parts.push(sf.text.slice(start, end));
  }
  let fn: ts.Node | undefined = n.parent;
  while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
  if (fn && ts.isFunctionLike(fn) && fn.name) parts.push(fn.name.getText(sf));
  return parts.join(' ');
}

const ARCH_007: Rule = {
  id: 'ARCH-007',
  title: 'no legal constant in code outside RuleParameter and migrations',
  check:
    `Heuristic: a numeric literal in {${LEGAL_NUMBERS.join(', ')}} whose enclosing statement, declaration, property or function name matches the legal-context pattern ` +
    '(leave, notice, probation, overtime, gratuity/end of service, GOSI, sick, maternity, hajj, levy, iqama, nitaqat…). Tests, migrations and seeds are not scanned. ' +
    'Limit: a legal value hidden behind a neutral name, or a neutral 30 next to a legal word, is misjudged; the baseline absorbs today\'s hits.',
  fix: 'Read the value with rules.valueAt(key, companyId, date) from RuleParameter (P1-RULE); the default lives in the RuleParameter seed with its legal source.',
  run: (p) => {
    const out: Violation[] = [];
    for (const f of codeAndScripts(p)) {
      if (LEGAL_SCAN_EXEMPT.some((re) => re.test(f.path))) continue;
      forEachDescendant(f.sf, (n) => {
        if (!ts.isNumericLiteral(n)) return;
        const value = Number(n.text.replace(/_/g, ''));
        if (!LEGAL_NUMBERS.includes(value)) return;
        const ctx = legalContextText(n, f.sf);
        const word = LEGAL_CONTEXT.exec(ctx);
        if (word) out.push(v('ARCH-007', f, lineOf(f.sf, n), `legal constant ${n.text} next to "${word[0]}"`));
      });
    }
    return out;
  },
};

const ARCH_008: Rule = {
  id: 'ARCH-008',
  title: 'scripts/ hold no business rules: they call the modules',
  check: 'Every Prisma write and every $executeRaw in scripts/** is a violation unless the script is in SCRIPT_WRITE_ALLOWLIST (J1 and reviewed data migrations).',
  fix: 'Move the rule into the owning module (P1-FND-JOBS builds the jobs from module code) and let the script call it.',
  run: (p) => {
    const out: Violation[] = [];
    for (const f of p.files) {
      if (f.kind !== 'script' || SCRIPT_WRITE_ALLOWLIST.includes(f.path)) continue;
      for (const c of callsOf(p, f)) if (c.write) out.push(v('ARCH-008', f, c.line, `script writes ${c.model} (.${c.op})`));
      forEachDescendant(f.sf, (n) => {
        if (ts.isPropertyAccessExpression(n) && /^\$executeRaw(Unsafe)?$/.test(n.name.text)) out.push(v('ARCH-008', f, lineOf(f.sf, n), `script runs ${n.name.text}`));
      });
    }
    return out;
  },
};

const RAW_SQL = /^\$(queryRaw|executeRaw)(Unsafe)?$/;

const ARCH_009: Rule = {
  id: 'ARCH-009',
  title: 'raw SQL only in reviewed src/modules/*/sql/, scoped by companyIds',
  check:
    '$queryRaw / $executeRaw / *Unsafe outside src/modules/<m>/sql/ is a violation (src and scripts). Inside sql/, raw SQL that names a company-scoped table ("Employee", "Leave"…) ' +
    'must sit in a function with a `companyIds` parameter.',
  fix: 'Move the query into src/modules/<m>/sql/ as a function taking companyIds: string[] (no default), or use the Prisma query API.',
  run: (p) => {
    const out: Violation[] = [];
    const scopedTables = [...p.schema.models.keys()].filter((m) => companyScoped(p, m));
    for (const f of codeAndScripts(p)) {
      const inSql = /^src\/modules\/[^/]+\/sql\//.test(f.path);
      forEachDescendant(f.sf, (n) => {
        if (!ts.isPropertyAccessExpression(n) || !RAW_SQL.test(n.name.text)) return;
        if (!inSql) {
          out.push(v('ARCH-009', f, lineOf(f.sf, n), `${n.name.text} outside src/modules/*/sql/`));
          return;
        }
        const use = n.parent;
        const sqlText = use.getText(f.sf);
        if (!scopedTables.some((t) => sqlText.includes(`"${t}"`))) return;
        let fn: ts.Node | undefined = n.parent;
        while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
        const hasParam = !!fn && ts.isFunctionLike(fn) && fn.parameters.some((prm) => /\bcompanyIds\b/.test(prm.name.getText(f.sf)));
        if (!hasParam) out.push(v('ARCH-009', f, lineOf(f.sf, n), 'raw SQL on a company-scoped table in a function without a companyIds parameter'));
      });
    }
    return out;
  },
};

const ARCH_010: Rule = {
  id: 'ARCH-010',
  title: 'every DomainEvent has an idempotencyKey; every consumer is registered with a key',
  check:
    'When the models exist: DomainEvent needs a unique idempotencyKey column, EventConsumption a unique key over (event, consumer). ' +
    'Every domainEvent.create / createMany / upsert must set idempotencyKey in its data literal. (Bites as soon as P1-FND-EVT adds the models.)',
  fix: 'Emit events through the platform events API with an idempotencyKey; declare @unique on DomainEvent.idempotencyKey and @@unique([eventId, consumer]) on EventConsumption.',
  run: (p) => {
    const out: Violation[] = [];
    const ev = p.schema.models.get('DomainEvent');
    if (ev) {
      const f = ev.fields.get('idempotencyKey');
      const unique = !!f && (/@unique\b/.test(f.attrs) || ev.blockAttrs.some((a) => /@@unique\(\[\s*idempotencyKey\s*\]/.test(a)));
      if (!unique) out.push({ rule: 'ARCH-010', key: schemaKey('DomainEvent'), line: ev.line, message: 'DomainEvent has no unique idempotencyKey' });
    }
    const cons = p.schema.models.get('EventConsumption');
    if (cons) {
      const ok = cons.blockAttrs.some((a) => /@@(unique|id)\(\[[^\]]*consumer[^\]]*\]/i.test(a) && /event/i.test(a));
      if (!ok) out.push({ rule: 'ARCH-010', key: schemaKey('EventConsumption'), line: cons.line, message: 'EventConsumption has no unique (event, consumer) key' });
    }
    for (const f of codeAndScripts(p)) {
      for (const c of callsOf(p, f)) {
        if (c.model !== 'DomainEvent' || !['create', 'createMany', 'createManyAndReturn', 'upsert'].includes(c.op)) continue;
        const { keys, opaque } = writtenKeys(c.call);
        if (!keys.has('idempotencyKey') && !opaque) out.push(v('ARCH-010', f, c.line, 'DomainEvent written without idempotencyKey'));
      }
    }
    return out;
  },
};

const ARCH_011: Rule = {
  id: 'ARCH-011',
  title: 'no financial calculation reads a projected salary field',
  check:
    `In files of ${FINANCIAL_CALC_MODULES.join(', ')} (src/modules or the legacy path map): selecting ${PROJECTED_SALARY_FIELDS.join('/')} from Employee ` +
    '(`basicSalary: true` inside an employee select/include or an Employee query), or reading it off an employee-named value (emp.basicSalary, x.employee.basicSalary). ' +
    'Limit: syntactic; a salary read from an Employee row held in a neutrally named variable is not seen, and Payroll snapshot columns of the same name are not flagged.',
  fix: 'Read compensation from effectiveContext(employee, date).compensation (or the approved snapshot).',
  run: (p) => {
    const out: Violation[] = [];
    for (const f of code(p)) {
      if (!f.module || !FINANCIAL_CALC_MODULES.includes(f.module)) continue;
      const empCalls = new Set(callsOf(p, f).filter((c) => c.model === 'Employee').map((c) => c.call));
      forEachDescendant(f.sf, (n) => {
        if (ts.isPropertyAccessExpression(n) && PROJECTED_SALARY_FIELDS.includes(n.name.text)) {
          const recv = n.expression.getText(f.sf);
          if (/(^|[.?])(emp|employee)[A-Za-z]*$/i.test(recv) || /^e$/.test(recv)) out.push(v('ARCH-011', f, lineOf(f.sf, n), `reads ${recv}.${n.name.text}`));
        }
        if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && PROJECTED_SALARY_FIELDS.includes(n.name.text) && n.initializer.kind === ts.SyntaxKind.TrueKeyword) {
          let cur: ts.Node = n.parent;
          let hit = false;
          while (cur && !hit) {
            if (ts.isPropertyAssignment(cur) && ts.isIdentifier(cur.name) && /^employees?$/.test(cur.name.text)) hit = true;
            if (ts.isCallExpression(cur) && empCalls.has(cur)) hit = true;
            if (ts.isFunctionLike(cur) || ts.isSourceFile(cur)) break;
            cur = cur.parent;
          }
          if (hit) out.push(v('ARCH-011', f, lineOf(f.sf, n), `selects Employee.${n.name.text}`));
        }
      });
    }
    return out;
  },
};

const ARCH_012: Rule = {
  id: 'ARCH-012',
  title: 'effective-period tables are written through platform/effective only',
  check:
    'Writes to period models (CompensationPeriod, AssignmentPeriod, EmploymentPeriod, ContractPeriod, BankIdentityPeriod, GosiRegistrationPeriod, and any model with validFrom + validTo) ' +
    'are allowed only in src/modules/platform/effective/.',
  fix: 'Open, supersede or close periods with the platform/effective functions (openPeriod / supersedePeriod / openLegacyPeriod).',
  run: (p) => {
    const out: Violation[] = [];
    const periods = periodModels(p);
    for (const f of codeAndScripts(p)) {
      if (f.path.startsWith('src/modules/platform/effective/')) continue;
      for (const c of callsOf(p, f)) if (c.write && periods.has(c.model)) out.push(v('ARCH-012', f, c.line, `writes period table ${c.model} (.${c.op}) outside platform/effective`));
    }
    return out;
  },
};

const ARCH_013: Rule = {
  id: 'ARCH-013',
  title: 'no amount arithmetic outside money.ts inside the money modules',
  check:
    `In files of ${MONEY_MODULES.join(', ')} other than money.ts: a * or / (or *=, /=) with a fractional literal operand (* 0.x) or one of ${MONEY_ARITH_INTEGERS.join(', ')} (/ 30, * 12, / 100…). ` +
    'Limit: pattern based; arithmetic through named constants is not seen.',
  fix: 'Use the money helpers (roundMoney, dailyRate, percentOf… in money.ts) so rounding happens once, in halalas.',
  run: (p) => {
    const out: Violation[] = [];
    const ops = new Set([ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken]);
    const moneyLiteral = (e: ts.Expression) => {
      if (!ts.isNumericLiteral(e)) return false;
      const n = Number(e.text.replace(/_/g, ''));
      return !Number.isInteger(n) || MONEY_ARITH_INTEGERS.includes(n);
    };
    for (const f of code(p)) {
      if (!f.module || !MONEY_MODULES.includes(f.module) || /(^|\/)money\.ts$/.test(f.path)) continue;
      forEachDescendant(f.sf, (n) => {
        if (ts.isBinaryExpression(n) && ops.has(n.operatorToken.kind) && (moneyLiteral(n.left) || moneyLiteral(n.right))) {
          out.push(v('ARCH-013', f, lineOf(f.sf, n), `amount arithmetic "${n.getText(f.sf).slice(0, 60)}"`));
        }
      });
    }
    return out;
  },
};

const IDEMPOTENCY_TITLE = /idempot|double|twice|concurren|repeat|مزدوج|تكرار/i;

function testTitles(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  forEachDescendant(sf, (n) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      const base = ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) ? n.expression.expression.text : name;
      if (base && ['describe', 'it', 'test'].includes(base) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) out.push(n.arguments[0].text);
    }
  });
  return out;
}

const ARCH_014: Rule = {
  id: 'ARCH-014',
  title: 'every transition has a double-call (idempotency) test',
  check:
    'Every export of src/modules/<m>/transitions.ts (or transitions/*.ts) must be named in a describe/it/test title of a test file in the same module, ' +
    'and that test file must contain an idempotency test (title matching idempotent/double/twice/concurrent/مزدوج/تكرار).',
  fix: 'Add a test that calls the transition twice (sequentially and concurrently) and asserts the same facts, events and notifications.',
  run: (p) => {
    const out: Violation[] = [];
    for (const f of code(p)) {
      const m = /^src\/modules\/([^/]+)\/transitions(\.ts|\/[^/]+\.ts)$/.exec(f.path);
      if (!m) continue;
      const tests = p.files.filter((t) => t.kind === 'test' && t.path.startsWith(`src/modules/${m[1]}/`)).map((t) => testTitles(t.sf));
      for (const st of f.sf.statements) {
        const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((x) => x.kind === ts.SyntaxKind.ExportKeyword);
        if (!exported) continue;
        const names: string[] = [];
        if (ts.isFunctionDeclaration(st) && st.name) names.push(st.name.text);
        if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
        for (const name of names) {
          const ok = tests.some((titles) => titles.some((t) => t.includes(name)) && titles.some((t) => IDEMPOTENCY_TITLE.test(t)));
          if (!ok) out.push(v('ARCH-014', f, lineOf(f.sf, st), `transition ${name} has no named idempotency test in src/modules/${m[1]}`));
        }
      }
    }
    return out;
  },
};

/** (table, column) pairs covered by a CHECK constraint in some migration. */
function checkedColumns(p: Project): Set<string> {
  const out = new Set<string>();
  for (const sql of p.migrations.values()) {
    for (const stmt of sql.split(';')) {
      const idx = stmt.search(/\bCHECK\s*\(/i);
      if (idx < 0) continue;
      const table = /(?:ALTER|CREATE)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?"(\w+)"/i.exec(stmt)?.[1];
      if (!table) continue;
      for (const m of stmt.slice(idx).matchAll(/"(\w+)"/g)) out.add(`${table}.${m[1]}`);
    }
  }
  return out;
}

const ARCH_015: Rule = {
  id: 'ARCH-015',
  title: 'every state column is an enum or has a CHECK',
  check:
    'A String field of prisma/schema.prisma named status / *Status / *State (except attributes in STATE_NAME_EXEMPT, e.g. maritalStatus) must be a Prisma enum or be named inside a CHECK constraint of some migration.',
  fix: 'Make the column an enum, or add a CHECK ("column" IN (…)) in a new letter-scheme migration (expand/contract).',
  run: (p) => {
    const out: Violation[] = [];
    const checked = checkedColumns(p);
    for (const m of p.schema.models.values()) {
      for (const f of m.fields.values()) {
        if (!/^(status|\w+(Status|State))$/.test(f.name) || STATE_NAME_EXEMPT.includes(f.name)) continue;
        if (f.type !== 'String') continue;
        if (checked.has(`${m.name}.${f.name}`)) continue;
        out.push({ rule: 'ARCH-015', key: schemaKey(m.name, f.name), line: f.line, message: `${m.name}.${f.name} is a free String state column` });
      }
    }
    return out;
  },
};

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function routeHandlers(sf: ts.SourceFile): { name: string; node: ts.Node }[] {
  const out: { name: string; node: ts.Node }[] = [];
  // `export const POST = saveSettings;` -> the body of the local saveSettings.
  const local = (name: string): ts.Node | null => {
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st;
      if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return d.initializer;
    }
    return null;
  };
  for (const st of sf.statements) {
    const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((x) => x.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isFunctionDeclaration(st) && st.name && HTTP_METHODS.has(st.name.text)) out.push({ name: st.name.text, node: st });
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !HTTP_METHODS.has(d.name.text) || !d.initializer) continue;
        const node = ts.isIdentifier(d.initializer) ? (local(d.initializer.text) ?? d.initializer) : d.initializer;
        out.push({ name: d.name.text, node });
      }
    }
  }
  return out;
}

const ARCH_016: Rule = {
  id: 'ARCH-016',
  title: 'every API route handler calls the permission guard',
  check:
    `Every exported HTTP handler of src/app/api/**/route.ts (except PUBLIC_ROUTES) must reach an auth guard (${AUTH_GUARDS.join(', ')}), directly or through a repo function it calls (resolved by import). ` +
    'Limit: whether the handler also checks the role of the actor is not judged here.',
  fix: 'Start the handler with requireUser(<roles>) (or requireEmployeeId for self-service).',
  run: (p) => {
    const out: Violation[] = [];
    const taint = computeTaint(p, AUTH_GUARDS);
    for (const f of code(p)) {
      if (!/^src\/app\/api\/.*\/route\.ts$/.test(f.path) || PUBLIC_ROUTES.includes(f.path)) continue;
      for (const h of routeHandlers(f.sf)) if (!taint.reaches(f.path, h.node)) out.push(v('ARCH-016', f, lineOf(f.sf, h.node), `${h.name} handler never calls an auth guard`));
    }
    return out;
  },
};

const ARCH_016_TEST: Rule = {
  id: 'ARCH-016.test',
  title: 'every API route has an allow/deny test with real (unmocked) auth',
  check:
    'Every non-public route.ts must be imported (statically or with import()) by a test file that does not vi.mock the auth module (src/lib/auth). ' +
    'Limit: that the test covers allow, deny and another company is not parsed; name them so a reviewer can see it.',
  fix: 'Add a test that drives the route with real sessions (mock next/headers and the database, not @/lib/auth): an allowed user, a denied role and a user of another company.',
  run: (p) => {
    const out: Violation[] = [];
    const covered = new Set<string>();
    for (const t of p.files) {
      if (t.kind !== 'test') continue;
      const mocksAuth = mockedSpecs(t.sf).some((s) => resolveImport(p, t.path, s) === 'src/lib/auth.ts');
      if (mocksAuth) continue;
      for (const imp of importsOf(t.sf)) {
        const target = resolveImport(p, t.path, imp.spec);
        if (target && /^src\/app\/api\/.*\/route\.ts$/.test(target)) covered.add(target);
      }
    }
    for (const f of code(p)) {
      if (!/^src\/app\/api\/.*\/route\.ts$/.test(f.path) || PUBLIC_ROUTES.includes(f.path)) continue;
      if (!covered.has(f.path)) out.push(v('ARCH-016.test', f, 1, 'no test imports this route with real auth'));
    }
    return out;
  },
};

const ARCH_017: Rule = {
  id: 'ARCH-017',
  title: 'no side effect (mail, document, integration, file) inside a transaction',
  check:
    `Inside a $transaction callback, no call reaches ${SIDE_EFFECT_CALLS.join(', ')} directly or through a repo function (resolved by import, to a fixpoint). ` +
    'Writing NotificationOutbox / DomainEvent rows in the transaction is the correct pattern and is not flagged. Limit: calls through object methods or callbacks held in variables are not followed.',
  fix: 'Emit a DomainEvent (or an outbox row) inside the transaction; do the side effect in its consumer after commit.',
  run: (p) => {
    const out: Violation[] = [];
    const files = codeAndScripts(p);
    const taint = computeTaint(p, SIDE_EFFECT_CALLS);
    for (const f of files) {
      for (const tx of transactionCalls(f.sf)) {
        if (!tx.body) continue;
        const hits = taint.hits(f.path, tx.body);
        if (hits.length) out.push(v('ARCH-017', f, lineOf(f.sf, tx.call), `side effect inside $transaction via ${hits.join(', ')}`));
      }
    }
    return out;
  },
};

const ARCH_018: Rule = {
  id: 'ARCH-018',
  title: 'every scheduled job in JOB_NAMES has an enabled timer',
  check: 'Enforced by src/lib/__tests__/ops-job-timers.test.ts (JOB_NAMES vs ops/systemd timers vs ops/run-jobs.sh). This rule only checks that the test still exists and names ARCH-018.',
  fix: 'Restore src/lib/__tests__/ops-job-timers.test.ts.',
  run: (p) => {
    const path = 'src/lib/__tests__/ops-job-timers.test.ts';
    const text = p.readText(path);
    return text && /ARCH-018/.test(text) && /JOB_NAMES/.test(text) ? [] : [{ rule: 'ARCH-018', key: path, line: 0, message: 'the ARCH-018 timer test is missing' }];
  },
};

function isLoop(n: ts.Node): boolean {
  if (ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)) return true;
  if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isCallExpression(n.parent)) {
    const name = calleeName(n.parent);
    return !!name && ['map', 'forEach', 'flatMap', 'reduce', 'all', 'allSettled'].includes(name);
  }
  return false;
}

/** where: { id } or where: { employeeId: <scalar> } targets one employee. */
function singleEmployeeWhere(call: ts.CallExpression): boolean {
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
  const where = arg.properties.find((x) => ts.isPropertyAssignment(x) && ts.isIdentifier(x.name) && x.name.text === 'where') as ts.PropertyAssignment | undefined;
  if (!where || !ts.isObjectLiteralExpression(where.initializer)) return false;
  return where.initializer.properties.some((x) => {
    const name = x.name && ts.isIdentifier(x.name) ? x.name.text : null;
    if (name !== 'id' && name !== 'employeeId') return false;
    if (ts.isShorthandPropertyAssignment(x)) return true;
    return ts.isPropertyAssignment(x) && !ts.isObjectLiteralExpression(x.initializer);
  });
}

const ARCH_019: Rule = {
  id: 'ARCH-019',
  title: 'a transaction writing several employees locks them first, by ascending id',
  check:
    'A $transaction whose body writes an employee-keyed model (Employee or a model with employeeId) for several employees (updateMany/deleteMany not narrowed to one id/employeeId, or a write inside a loop / map / Promise.all), ' +
    'or an array $transaction built with map, must call lockEmployees(tx, ids) before its first write and before any other lock (FOR UPDATE). Limit: several single writes to different employees in straight-line code are not seen.',
  fix: 'Call people.lockEmployees(tx, employeeIds) (ascending id) as the first statement of the transaction (ADR-0002 #2).',
  run: (p) => {
    const out: Violation[] = [];
    for (const f of codeAndScripts(p)) {
      const calls = callsOf(p, f).filter((c) => c.write && employeeKeyed(p, c.model));
      if (!calls.length) continue;
      for (const tx of transactionCalls(f.sf)) {
        const scope = tx.body ?? tx.array;
        if (!scope) continue;
        const inside = calls.filter((c) => c.call.pos >= scope.pos && c.call.end <= scope.end);
        const multi = inside.filter((c) => {
          if (['updateMany', 'deleteMany'].includes(c.op) && !singleEmployeeWhere(c.call)) return true;
          let cur: ts.Node = c.call.parent;
          while (cur && cur !== scope) {
            if (isLoop(cur)) return true;
            cur = cur.parent;
          }
          return false;
        });
        if (!multi.length) continue;
        let lockPos = -1;
        let otherLockPos = -1;
        forEachDescendant(scope, (n) => {
          if (ts.isCallExpression(n) && calleeName(n) === 'lockEmployees' && lockPos < 0) lockPos = n.pos;
          if ((ts.isTemplateLiteral(n) || ts.isStringLiteral(n)) && /FOR\s+(NO\s+KEY\s+)?UPDATE/i.test(n.getText(f.sf)) && otherLockPos < 0) otherLockPos = n.pos;
        });
        const firstWrite = Math.min(...inside.map((c) => c.call.pos));
        if (lockPos < 0) out.push(v('ARCH-019', f, lineOf(f.sf, tx.call), `writes ${[...new Set(multi.map((c) => c.model))].join(', ')} for several employees without lockEmployees`));
        else if (lockPos > firstWrite || (otherLockPos >= 0 && otherLockPos < lockPos)) out.push(v('ARCH-019', f, lineOf(f.sf, tx.call), 'lockEmployees is not the first lock of the transaction'));
      }
    }
    return out;
  },
};

/** The models of the approval engine that are keyed by beneficiaries (their writes follow the employee lock). */
const WORKFLOW_LOCKED_MODELS = ['WorkflowInstance', 'WorkflowTask'];

/** Top-level functions (declarations and const arrows) of a file, by name. */
function topLevelBodies(sf: ts.SourceFile): Map<string, { node: ts.Node; exported: boolean }> {
  const out = new Map<string, { node: ts.Node; exported: boolean }>();
  for (const st of sf.statements) {
    const exported = !!(ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((x) => x.kind === ts.SyntaxKind.ExportKeyword));
    if (ts.isFunctionDeclaration(st) && st.name && st.body) out.set(st.name.text, { node: st, exported });
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) out.set(d.name.text, { node: d.initializer, exported });
      }
    }
  }
  return out;
}

const ARCH_019_PORT: Rule = {
  id: 'ARCH-019.port',
  title: 'every engine transition takes the employee lock (EmployeeLockPort.lockEmployees) before its first write',
  check:
    `Every export of src/modules/workflow/transitions/*.ts that writes ${WORKFLOW_LOCKED_MODELS.join(' / ')} (directly or through a function of src/modules/workflow, resolved by name) ` +
    'must call lockEmployees (the port method) before: in source order, the first call that reaches a lock comes before the first call that reaches a write; a call that reaches both is ' +
    'checked the same way inside its callee. Definitions (WorkflowDefinition) have no employee and are not checked. Limit: names are resolved inside the workflow module only, and a call ' +
    'passed as a callback counts where it is written.',
  fix: 'Start the transition with openFrame / lockParties (requirePort("EmployeeLock").lockEmployees(tx, beneficiaries ascending, ctx.companies)), then adapter.lockKeys, then read and write (AUDIT/16 §3.2).',
  run: (p) => {
    const out: Violation[] = [];
    const files = code(p).filter((f) => f.path.startsWith('src/modules/workflow/'));
    const decls = new Map<string, { node: ts.Node; file: SourceInfo; exported: boolean }>();
    for (const f of files) for (const [name, d] of topLevelBodies(f.sf)) decls.set(name, { ...d, file: f });
    const writeCalls = new Set<ts.CallExpression>();
    for (const f of files) for (const c of callsOf(p, f)) if (c.write && WORKFLOW_LOCKED_MODELS.includes(c.model)) writeCalls.add(c.call);
    const callsIn = (node: ts.Node): ts.CallExpression[] => {
      const calls: ts.CallExpression[] = [];
      forEachDescendant(node, (n) => {
        if (ts.isCallExpression(n)) calls.push(n);
      });
      return calls.sort((a, b) => a.pos - b.pos);
    };
    const memo = new Map<string, { lock: boolean; write: boolean }>();
    const reach = (name: string, seen = new Set<string>()): { lock: boolean; write: boolean } => {
      const hit = memo.get(name);
      if (hit) return hit;
      const d = decls.get(name);
      if (!d || seen.has(name)) return { lock: false, write: false };
      seen.add(name);
      const r = { lock: false, write: false };
      for (const c of callsIn(d.node)) {
        const n = calleeName(c);
        if (n === 'lockEmployees') r.lock = true;
        if (writeCalls.has(c)) r.write = true;
        if (n && decls.has(n) && n !== name) {
          const s = reach(n, seen);
          r.lock ||= s.lock;
          r.write ||= s.write;
        }
      }
      memo.set(name, r);
      return r;
    };
    /** In source order, is the first lock-reaching call before the first write-reaching one? */
    const ordered = (name: string, seen = new Set<string>()): boolean => {
      const d = decls.get(name);
      if (!d || seen.has(name)) return true;
      seen.add(name);
      for (const c of callsIn(d.node)) {
        const n = calleeName(c);
        if (n === 'lockEmployees') return true;
        if (writeCalls.has(c)) return false;
        if (n && decls.has(n) && n !== name) {
          const s = reach(n);
          if (s.lock && s.write) return ordered(n, seen);
          if (s.lock) return true;
          if (s.write) return false;
        }
      }
      return true;
    };
    for (const [name, d] of decls) {
      if (!d.exported || !/^src\/modules\/workflow\/transitions\/[^/]+\.ts$/.test(d.file.path)) continue;
      const r = reach(name);
      if (!r.write) continue;
      if (!r.lock) out.push(v('ARCH-019.port', d.file, lineOf(d.file.sf, d.node), `transition ${name} writes ${WORKFLOW_LOCKED_MODELS.join('/')} without calling lockEmployees`));
      else if (!ordered(name)) out.push(v('ARCH-019.port', d.file, lineOf(d.file.sf, d.node), `transition ${name} writes before lockEmployees`));
    }
    return out;
  },
};

const ARCH_017_ADAPTER: Rule = {
  id: 'ARCH-017.adapter',
  title: 'no side effect anywhere in the approval engine or in a workflow adapter',
  check:
    `No call in src/modules/workflow/** or src/modules/*/workflow-adapter.ts reaches ${SIDE_EFFECT_CALLS.join(', ')} (directly or through a repo function, resolved by import). ` +
    'Hooks run inside the engine transaction (ARC-WFE-A2), so the whole file is the transaction scope. Limit: as ARCH-017.',
  fix: 'Emit a DomainEvent from the hook (or let the engine emit workflow.*) and do the side effect in a consumer after commit.',
  run: (p) => {
    const out: Violation[] = [];
    const taint = computeTaint(p, SIDE_EFFECT_CALLS);
    for (const f of code(p)) {
      if (!f.path.startsWith('src/modules/workflow/') && !/^src\/modules\/[^/]+\/workflow-adapter\.ts$/.test(f.path)) continue;
      const hits = taint.hits(f.path, f.sf);
      if (hits.length) out.push(v('ARCH-017.adapter', f, 1, `side effect in the engine / an adapter via ${hits.join(', ')}`));
    }
    return out;
  },
};

const ARCH_020: Rule = {
  id: 'ARCH-020',
  title: 'every adapter declaring an exitPolicy consumes employment.terminated',
  check:
    "A property `exitPolicy` in src/modules/<m>/ requires src/modules/<m>/consumers.ts (or consumers/*.ts) to name 'employment.terminated'. (Bites as soon as workflow adapters exist.)",
  fix: "Add a consumer of 'employment.terminated' in the module's consumers.ts that applies the exit policy (ADR-0002 #10).",
  run: (p) => {
    const out: Violation[] = [];
    for (const f of code(p)) {
      if (!f.inModules || !f.module) continue;
      forEachDescendant(f.sf, (n) => {
        const named = (ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n) || ts.isShorthandPropertyAssignment(n)) && n.name.getText(f.sf) === 'exitPolicy';
        if (!named) return;
        const consumers = p.files.filter((c) => c.path === `src/modules/${f.module}/consumers.ts` || c.path.startsWith(`src/modules/${f.module}/consumers/`));
        const ok = consumers.some((c) => /['"`]employment\.terminated['"`]/.test(c.sf.text));
        if (!ok) out.push(v('ARCH-020', f, lineOf(f.sf, n), `module ${f.module} declares exitPolicy but has no consumer of employment.terminated`));
      });
    }
    return out;
  },
};

/** The literal period kind of an argument: 'KIND', `KIND`, 'KIND' as const, X.KIND, or a local const. */
function literalKind(arg: ts.Expression | undefined, sf: ts.SourceFile): string | null {
  let e = arg;
  while (e && (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e))) e = e.expression;
  if (!e) return null;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text in PERIOD_KIND_OWNERS ? e.name.text : null;
  if (ts.isIdentifier(e)) {
    const id = e.text;
    let found: string | null = null;
    forEachDescendant(sf, (n) => {
      if (found || !ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || n.name.text !== id || !n.initializer) return;
      const list = n.parent;
      if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return;
      found = literalKind(n.initializer, sf);
    });
    return found;
  }
  return null;
}

/** Local names bound to the period writers (named imports, including `openPeriod as x`). */
function periodWriterNames(sf: ts.SourceFile): Map<string, string> {
  const names = new Map(PERIOD_WRITERS.map((w) => [w, w]));
  forEachDescendant(sf, (n) => {
    if (!ts.isImportSpecifier(n) || !n.propertyName) return;
    const imported = n.propertyName.text;
    if (PERIOD_WRITERS.includes(imported)) names.set(n.name.text, imported);
  });
  return names;
}

const ARCH_021: Rule = {
  id: 'ARCH-021',
  title: 'only the owning module writes its kind of effective period (ADR-0005)',
  check:
    `A call to ${PERIOD_WRITERS.join(' / ')} (directly, as a method, or through an import alias) whose kind argument is a literal (${Object.keys(PERIOD_KIND_OWNERS).join(', ')}; ` +
    "a string, `as const`, X.KIND or a local const) is allowed only in the kind's owning module " +
    `(${Object.entries(PERIOD_KIND_OWNERS).map(([k, m]) => `${k}: ${m}`).join(', ')}) and in src/modules/platform/effective/. Tests are not checked; ` +
    'openLegacyPeriod / backfillLegacyOpenings (legacy opening, ADR-0002 #8) are exempt. A kind passed as a variable is not resolved.',
  fix: "Call the owning module's transition (lifecycle for EMPLOYMENT, compensation for COMPENSATION, org for ASSIGNMENT) instead of platform/effective directly.",
  run: (p) => {
    const out: Violation[] = [];
    for (const f of code(p)) {
      if (f.path.startsWith('src/modules/platform/effective/')) continue;
      const writers = periodWriterNames(f.sf);
      forEachDescendant(f.sf, (n) => {
        if (!ts.isCallExpression(n)) return;
        const name = calleeName(n);
        const writer = name ? writers.get(name) : undefined;
        if (!writer) return;
        const kind = literalKind(n.arguments[1], f.sf);
        const owner = kind ? PERIOD_KIND_OWNERS[kind] : undefined;
        if (!owner || f.module === owner) return;
        out.push(v('ARCH-021', f, lineOf(f.sf, n), `${writer}(…, '${kind}') outside ${owner} (in ${f.module ?? 'unassigned code'}); only ${owner} writes ${kind} periods (ADR-0005)`));
      });
    }
    return out;
  },
};

export const RULES: Rule[] = [
  ARCH_001,
  ARCH_001_DIR,
  ARCH_002,
  ARCH_002_OWNER,
  ARCH_003,
  ARCH_004,
  ARCH_005,
  ARCH_006,
  ARCH_007,
  ARCH_008,
  ARCH_009,
  ARCH_010,
  ARCH_011,
  ARCH_012,
  ARCH_013,
  ARCH_014,
  ARCH_015,
  ARCH_016,
  ARCH_016_TEST,
  ARCH_017,
  ARCH_017_ADAPTER,
  ARCH_018,
  ARCH_019,
  ARCH_019_PORT,
  ARCH_020,
  ARCH_021,
];
