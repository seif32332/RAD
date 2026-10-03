// The definition language (wfe-to-be.md §12.2, AUDIT/16 §3.3) and the save-time checks (§12.3), without the
// money amendment (DEC-PO-139). Strict at every level: an unknown key (adminMoneyMode, alternateCollision,
// loanCancelApprovers, dropDeductionApprovers or any other money key) is refused, not ignored.
import { createHash } from 'crypto';
import { z } from 'zod';
import { ALL_ROLES, type AppRole } from '@/lib/constants';
import { WorkflowError } from './errors';

// ---------------------------------------------------------------------------------------------------
// Field catalogs (declared by each adapter)

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'enum';
export interface FieldSpec {
  type: FieldType;
  /** enum: the allowed values. */
  values?: readonly string[];
}
export type FieldCatalog = Readonly<Record<string, FieldSpec>>;

// ---------------------------------------------------------------------------------------------------
// Schema

export const DEFINITION_LIMITS = Object.freeze({ maxDepth: 5, maxStages: 20, maxChainLevels: 5, maxDeadlineWorkingDays: 60 });

const NODE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
const roleSchema = z.enum(ALL_ROLES as unknown as [AppRole, ...AppRole[]]);
const scalar = z.union([z.string(), z.number(), z.boolean()]);

export type Expr =
  | { field: string; op: 'eq' | 'neq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists'; value?: string | number | boolean | (string | number | boolean)[] }
  | { all: Expr[] }
  | { any: Expr[] }
  | { not: Expr };

const exprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z
      .object({
        field: z.string().min(1).max(64),
        op: z.enum(['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'exists']),
        value: z.union([scalar, z.array(scalar).max(50)]).optional(),
      })
      .strict(),
    z.object({ all: z.array(exprSchema).max(20) }).strict(),
    z.object({ any: z.array(exprSchema).max(20) }).strict(),
    z.object({ not: exprSchema }).strict(),
  ]),
);

export type Approver = { kind: 'MANAGER_CHAIN'; levels: number } | { kind: 'ROLE'; role: AppRole };
export interface StageNode {
  type: 'stage';
  id: string;
  approver: Approver;
  deadline?: { workingDays: number; onDeadline: 'COVER' | 'NOTIFY' | 'ESCALATE' };
  distinctFromPrior?: boolean;
  decisionFields?: string[];
}
export interface SequenceNode {
  type: 'sequence';
  id: string;
  children: WfNode[];
}
export interface ConditionNode {
  type: 'condition';
  id: string;
  branches: { when: Expr; node: WfNode }[];
  otherwise?: WfNode;
}
export interface ParallelNode {
  type: 'parallel';
  id: string;
  join: 'ALL' | 'ANY';
  branches: WfNode[];
}
export type WfNode = StageNode | SequenceNode | ConditionNode | ParallelNode;

const nodeSchema: z.ZodType<WfNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z
      .object({
        type: z.literal('stage'),
        id: z.string().regex(NODE_ID),
        approver: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('MANAGER_CHAIN'), levels: z.number().int().min(1).max(DEFINITION_LIMITS.maxChainLevels) }).strict(),
          z.object({ kind: z.literal('ROLE'), role: roleSchema }).strict(),
        ]),
        deadline: z
          .object({ workingDays: z.number().int().min(1).max(DEFINITION_LIMITS.maxDeadlineWorkingDays), onDeadline: z.enum(['COVER', 'NOTIFY', 'ESCALATE']) })
          .strict()
          .optional(),
        distinctFromPrior: z.boolean().optional(),
        decisionFields: z.array(z.string().min(1).max(64)).max(20).optional(),
      })
      .strict(),
    z.object({ type: z.literal('sequence'), id: z.string().regex(NODE_ID), children: z.array(nodeSchema).max(50) }).strict(),
    z
      .object({
        type: z.literal('condition'),
        id: z.string().regex(NODE_ID),
        branches: z.array(z.object({ when: exprSchema, node: nodeSchema }).strict()).min(1).max(20),
        otherwise: nodeSchema.optional(),
      })
      .strict(),
    z.object({ type: z.literal('parallel'), id: z.string().regex(NODE_ID), join: z.enum(['ALL', 'ANY']), branches: z.array(nodeSchema).min(2).max(10) }).strict(),
  ]) as unknown as z.ZodType<WfNode>,
);

export const settingsSchema = z
  .object({
    maxReturns: z.number().int().min(0).nullable(),
    returnExpiryWorkingDays: z.number().int().min(1).nullable(),
    coverRole: roleSchema.nullable(),
    rejectRequiresPair: z.boolean(),
    rejectAuthority: z.array(roleSchema).max(ALL_ROLES.length),
    autoDefaults: z.record(z.string().min(1).max(64), z.unknown()).optional(),
  })
  .strict();
export type DefinitionSettings = z.infer<typeof settingsSchema>;

export const definitionSchema = z.object({ schemaVersion: z.literal(1), settings: settingsSchema, root: nodeSchema }).strict();
export interface WorkflowDefinitionDoc {
  schemaVersion: 1;
  settings: DefinitionSettings;
  root: WfNode;
}

// ---------------------------------------------------------------------------------------------------
// Checksum

/** Canonical JSON: object keys sorted at every level (so reordering keys does not change the checksum). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function definitionChecksum(doc: unknown): string {
  return createHash('sha256').update(canonicalJson(doc)).digest('hex');
}

// ---------------------------------------------------------------------------------------------------
// Save-time checks (§12.3)

export interface DefinitionCatalogs {
  fieldCatalog: FieldCatalog;
  decisionFieldCatalog: FieldCatalog;
  requiredDecisionFields?: readonly string[];
}

export interface DefinitionProblem {
  path: string;
  problem: string;
}

/** Every stage of the tree, with MANAGER_CHAIN counted per level. */
function stageCount(n: WfNode): number {
  switch (n.type) {
    case 'stage':
      return n.approver.kind === 'MANAGER_CHAIN' ? n.approver.levels : 1;
    case 'sequence':
      return n.children.reduce((s, c) => s + stageCount(c), 0);
    case 'condition':
      return Math.max(0, ...n.branches.map((b) => stageCount(b.node)), n.otherwise ? stageCount(n.otherwise) : 0);
    case 'parallel':
      return n.branches.reduce((s, c) => s + stageCount(c), 0);
  }
}

function depthOf(n: WfNode): number {
  switch (n.type) {
    case 'stage':
      return 1;
    case 'sequence':
      return 1 + Math.max(0, ...n.children.map(depthOf));
    case 'condition':
      return 1 + Math.max(0, ...n.branches.map((b) => depthOf(b.node)), n.otherwise ? depthOf(n.otherwise) : 0);
    case 'parallel':
      return 1 + Math.max(0, ...n.branches.map(depthOf));
  }
}

/** A trivially constant expression: `{all: []}` is always true, `{any: []}` always false. */
function constantOf(e: Expr): boolean | null {
  if ('all' in e) {
    const parts = e.all.map(constantOf);
    if (parts.includes(false)) return false;
    return parts.every((p) => p === true) ? true : null;
  }
  if ('any' in e) {
    const parts = e.any.map(constantOf);
    if (parts.includes(true)) return true;
    return parts.every((p) => p === false) ? false : null;
  }
  if ('not' in e) {
    const c = constantOf(e.not);
    return c === null ? null : !c;
  }
  return null;
}

function checkExpr(e: Expr, known: Map<string, FieldSpec>, path: string, out: DefinitionProblem[]): void {
  if ('all' in e) return e.all.forEach((x, i) => checkExpr(x, known, `${path}.all[${i}]`, out));
  if ('any' in e) return e.any.forEach((x, i) => checkExpr(x, known, `${path}.any[${i}]`, out));
  if ('not' in e) return checkExpr(e.not, known, `${path}.not`, out);
  const spec = known.get(e.field);
  if (!spec) {
    out.push({ path, problem: `unknown field "${e.field}" (not in the catalog, or a decision field without an earlier stage that collects it)` });
    return;
  }
  const v = e.value;
  if (e.op === 'exists') {
    if (v !== undefined) out.push({ path, problem: 'exists takes no value' });
    return;
  }
  if (v === undefined) {
    out.push({ path, problem: `${e.op} needs a value` });
    return;
  }
  const okScalar = (x: unknown): boolean => {
    switch (spec.type) {
      case 'number':
        return typeof x === 'number' && Number.isFinite(x);
      case 'boolean':
        return typeof x === 'boolean';
      case 'date':
        return typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
      case 'enum':
        return typeof x === 'string' && (spec.values ?? []).includes(x);
      case 'string':
        return typeof x === 'string';
    }
  };
  if (e.op === 'in') {
    if (!Array.isArray(v) || !v.length || !v.every(okScalar)) out.push({ path, problem: `in needs a non-empty list of ${spec.type} values` });
    return;
  }
  if (Array.isArray(v) || !okScalar(v)) {
    out.push({ path, problem: `value does not match the ${spec.type} field "${e.field}"` });
    return;
  }
  if (['gt', 'gte', 'lt', 'lte'].includes(e.op) && !['number', 'date'].includes(spec.type)) {
    out.push({ path, problem: `${e.op} is only for number and date fields` });
  }
}

/** Every path of the tree (condition branches and parallel branches enumerated), as the decision fields collected. */
function pathsOf(n: WfNode): Set<string>[] {
  const cap = 256;
  const join = (a: Set<string>[], b: Set<string>[]): Set<string>[] => {
    const out: Set<string>[] = [];
    for (const x of a) for (const y of b) if (out.length < cap) out.push(new Set([...x, ...y]));
    return out;
  };
  switch (n.type) {
    case 'stage':
      return [new Set(n.decisionFields ?? [])];
    case 'sequence':
      return n.children.reduce<Set<string>[]>((acc, c) => join(acc, pathsOf(c)), [new Set()]);
    case 'condition': {
      const all = n.branches.flatMap((b) => pathsOf(b.node));
      return [...all, ...(n.otherwise ? pathsOf(n.otherwise) : [new Set<string>()])].slice(0, cap);
    }
    case 'parallel':
      // ALL: every branch runs. ANY: any one branch may be the one that completes.
      return n.join === 'ALL' ? n.branches.reduce<Set<string>[]>((acc, c) => join(acc, pathsOf(c)), [new Set()]) : n.branches.flatMap(pathsOf).slice(0, cap);
  }
}

/**
 * §12.3: parallel with one branch (schema), unknown role (schema) or field or a type that does not match, a decision
 * field used before a stage collects it, an unreachable branch, a path that misses a required decision field and has
 * no autoDefault for it; and the limits (depth 5, 20 stages, chain 5). Returns the problems (empty = valid).
 */
export function definitionProblems(raw: unknown, catalogs: DefinitionCatalogs): DefinitionProblem[] {
  const parsed = definitionSchema.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((i) => ({ path: i.path.join('.') || '(root)', problem: i.message }));
  const doc = parsed.data as WorkflowDefinitionDoc;
  const out: DefinitionProblem[] = [];

  if (depthOf(doc.root) > DEFINITION_LIMITS.maxDepth) out.push({ path: 'root', problem: `nesting deeper than ${DEFINITION_LIMITS.maxDepth}` });
  if (stageCount(doc.root) > DEFINITION_LIMITS.maxStages) out.push({ path: 'root', problem: `more than ${DEFINITION_LIMITS.maxStages} stages` });

  const ids = new Set<string>();
  const decisionCatalog = new Map(Object.entries(catalogs.decisionFieldCatalog));
  // Walk in execution order with the fields known at each point (context fields + decision fields collected before).
  const walk = (n: WfNode, path: string, known: Map<string, FieldSpec>): Map<string, FieldSpec> => {
    if (ids.has(n.id)) out.push({ path, problem: `duplicate node id "${n.id}"` });
    ids.add(n.id);
    switch (n.type) {
      case 'stage': {
        const next = new Map(known);
        for (const f of n.decisionFields ?? []) {
          const spec = decisionCatalog.get(f);
          if (!spec) out.push({ path: `${path}.decisionFields`, problem: `unknown decision field "${f}"` });
          else next.set(f, spec);
        }
        return next;
      }
      case 'sequence': {
        let k = known;
        n.children.forEach((c, i) => (k = walk(c, `${path}.children[${i}]`, k)));
        return k;
      }
      case 'condition': {
        const seen = new Set<string>();
        let alwaysTaken = false;
        n.branches.forEach((b, i) => {
          const p = `${path}.branches[${i}]`;
          checkExpr(b.when, known, `${p}.when`, out);
          const c = constantOf(b.when);
          const sig = canonicalJson(b.when);
          if (alwaysTaken) out.push({ path: p, problem: 'unreachable branch: an earlier branch is always taken' });
          else if (c === false) out.push({ path: p, problem: 'unreachable branch: its condition is never true' });
          else if (seen.has(sig)) out.push({ path: p, problem: 'unreachable branch: same condition as an earlier branch' });
          if (c === true) alwaysTaken = true;
          seen.add(sig);
          walk(b.node, `${p}.node`, known);
        });
        if (n.otherwise) {
          if (alwaysTaken) out.push({ path: `${path}.otherwise`, problem: 'unreachable otherwise: an earlier branch is always taken' });
          walk(n.otherwise, `${path}.otherwise`, known);
        }
        // After a condition, only the fields collected on every branch are known for sure.
        return known;
      }
      case 'parallel': {
        n.branches.forEach((b, i) => walk(b, `${path}.branches[${i}]`, known));
        return known;
      }
    }
  };
  walk(doc.root, 'root', new Map(Object.entries(catalogs.fieldCatalog)));

  for (const k of Object.keys(doc.settings.autoDefaults ?? {})) {
    if (!decisionCatalog.has(k)) out.push({ path: `settings.autoDefaults.${k}`, problem: `unknown decision field "${k}"` });
  }
  const required = catalogs.requiredDecisionFields ?? [];
  if (required.length) {
    const defaults = new Set(Object.keys(doc.settings.autoDefaults ?? {}));
    for (const p of pathsOf(doc.root)) {
      const missing = required.filter((f) => !p.has(f) && !defaults.has(f));
      if (missing.length) {
        out.push({ path: 'root', problem: `a path collects neither the required decision field(s) ${missing.join(', ')} nor has an autoDefault for them` });
        break;
      }
    }
  }
  return out;
}

/** The parsed definition, or WFE_DEFINITION_INVALID with the problems. */
export function parseDefinition(raw: unknown, catalogs: DefinitionCatalogs): WorkflowDefinitionDoc {
  const problems = definitionProblems(raw, catalogs);
  if (problems.length) throw new WorkflowError('WFE_DEFINITION_INVALID', problems.map((p) => `${p.path}: ${p.problem}`).join('; '), { problems });
  return definitionSchema.parse(raw) as WorkflowDefinitionDoc;
}

/** A stored definition (already checked when saved): the schema only, as a defence against a hand-edited row. */
export function readStoredDefinition(raw: unknown): WorkflowDefinitionDoc {
  const parsed = definitionSchema.safeParse(raw);
  if (!parsed.success) throw new WorkflowError('WFE_DEFINITION_INVALID', 'stored definition does not match the schema');
  return parsed.data as WorkflowDefinitionDoc;
}

/** True when the tree has a MANAGER_CHAIN stage (ManagerChainPort and AvailabilityPort become required). */
export function usesManagerChain(n: WfNode): boolean {
  switch (n.type) {
    case 'stage':
      return n.approver.kind === 'MANAGER_CHAIN';
    case 'sequence':
      return n.children.some(usesManagerChain);
    case 'condition':
      return n.branches.some((b) => usesManagerChain(b.node)) || (!!n.otherwise && usesManagerChain(n.otherwise));
    case 'parallel':
      return n.branches.some(usesManagerChain);
  }
}

/** True when any stage has a deadline (WorkingDaysPort becomes required). */
export function hasDeadline(n: WfNode): boolean {
  switch (n.type) {
    case 'stage':
      return !!n.deadline;
    case 'sequence':
      return n.children.some(hasDeadline);
    case 'condition':
      return n.branches.some((b) => hasDeadline(b.node)) || (!!n.otherwise && hasDeadline(n.otherwise));
    case 'parallel':
      return n.branches.some(hasDeadline);
  }
}

// ---------------------------------------------------------------------------------------------------
// Loosened controls (BL-WFE-003, wfe-to-be.md §12.1 "ما لا يُعطَّل"): what a new version relaxes against the version
// in force for the same (type, company). The editor shows these as warnings, the activation must confirm them, and the
// activation records them (CONTROL_RELAXED) for the owner digest. G1, G1b and G2b themselves are not settings of the
// language (the engine always applies them; only the single-operator exception waives them, and records it).

export type RelaxationCode =
  | 'AUTO_APPROVE_PATH'
  | 'FEWER_HUMAN_STAGES'
  | 'REJECT_PAIR_REMOVED'
  | 'REJECT_AUTHORITY_WIDENED'
  | 'DISTINCT_FROM_PRIOR_REMOVED'
  | 'PARALLEL_ALL_REMOVED'
  | 'COVER_ROLE_CHANGED';

export interface DefinitionWarning {
  code: RelaxationCode;
  /** Arabic, for the editor. */
  message: string;
}

export const RELAXATION_MESSAGES: Readonly<Record<RelaxationCode, string>> = Object.freeze({
  AUTO_APPROVE_PATH: 'في المسار طريق يُعتمد فيه الطلب آلياً دون أي مرحلة بشرية (G2: يُسجَّل ويصل ملخص صاحب الشركة)',
  FEWER_HUMAN_STAGES: 'أقل عدد من المعتمدين على أي طريق في المسار أصبح أقل من الإصدار المعمول به',
  REJECT_PAIR_REMOVED: 'أُلغي اشتراط شخص ثانٍ لتأكيد الرفض (G2b)',
  REJECT_AUTHORITY_WIDENED: 'أُضيفت أدوار جديدة تملك رفض الطلب في أي مرحلة',
  DISTINCT_FROM_PRIOR_REMOVED: 'أُلغي اشتراط أن يكون معتمد مرحلة غير من اعتمد قبله (G2b)',
  PARALLEL_ALL_REMOVED: 'مراحل متوازية كانت تتطلب موافقة الجميع أصبحت تكتفي بموافقة واحد (G2b)',
  COVER_ROLE_CHANGED: 'تغيّر الدور الذي يغطي المراحل عند غياب المعتمد',
});

/** The fewest human approvals on any path (a MANAGER_CHAIN stage counts its levels; a skipped condition counts 0). */
export function minHumanStages(n: WfNode): number {
  switch (n.type) {
    case 'stage':
      return n.approver.kind === 'MANAGER_CHAIN' ? n.approver.levels : 1;
    case 'sequence':
      return n.children.reduce((s, c) => s + minHumanStages(c), 0);
    case 'condition':
      return Math.min(...n.branches.map((b) => minHumanStages(b.node)), n.otherwise ? minHumanStages(n.otherwise) : 0);
    case 'parallel':
      return n.join === 'ALL' ? n.branches.reduce((s, c) => s + minHumanStages(c), 0) : Math.min(...n.branches.map(minHumanStages));
  }
}

function countNodes(n: WfNode, pred: (x: WfNode) => boolean): number {
  const own = pred(n) ? 1 : 0;
  switch (n.type) {
    case 'stage':
      return own;
    case 'sequence':
      return own + n.children.reduce((s, c) => s + countNodes(c, pred), 0);
    case 'condition':
      return own + n.branches.reduce((s, b) => s + countNodes(b.node, pred), 0) + (n.otherwise ? countNodes(n.otherwise, pred) : 0);
    case 'parallel':
      return own + n.branches.reduce((s, c) => s + countNodes(c, pred), 0);
  }
}

/**
 * What `next` loosens against `prev`, the version in force (null: none, so only an automatic path is a warning).
 * Pure; the order is stable.
 */
export function definitionRelaxations(prev: WorkflowDefinitionDoc | null, next: WorkflowDefinitionDoc): DefinitionWarning[] {
  const codes: RelaxationCode[] = [];
  const nextMin = minHumanStages(next.root);
  const prevMin = prev ? minHumanStages(prev.root) : null;
  if (nextMin === 0 && (prevMin === null || prevMin > 0)) codes.push('AUTO_APPROVE_PATH');
  if (prevMin !== null && nextMin > 0 && nextMin < prevMin) codes.push('FEWER_HUMAN_STAGES');
  if (prev) {
    if (prev.settings.rejectRequiresPair && !next.settings.rejectRequiresPair) codes.push('REJECT_PAIR_REMOVED');
    if (next.settings.rejectAuthority.some((r) => !prev.settings.rejectAuthority.includes(r))) codes.push('REJECT_AUTHORITY_WIDENED');
    const distinct = (d: WorkflowDefinitionDoc) => countNodes(d.root, (x) => x.type === 'stage' && x.distinctFromPrior === true);
    if (distinct(next) < distinct(prev)) codes.push('DISTINCT_FROM_PRIOR_REMOVED');
    const all = (d: WorkflowDefinitionDoc) => countNodes(d.root, (x) => x.type === 'parallel' && x.join === 'ALL');
    if (all(next) < all(prev)) codes.push('PARALLEL_ALL_REMOVED');
    if (next.settings.coverRole !== null && next.settings.coverRole !== prev.settings.coverRole) codes.push('COVER_ROLE_CHANGED');
  }
  return codes.map((code) => ({ code, message: RELAXATION_MESSAGES[code] }));
}
