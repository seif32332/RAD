// Pure analysis of what a Prisma operation writes (BR-PAY-018; the extended spike BL-PAY-024).
//
// Prisma hands a query extension ONE operation for a whole nested write (EVD-SYS-016: a nested
// `allowances: { create: … }` inside employee.create is not a separate Allowance operation), so the
// extension walks `args.data` recursively from any model, over the relation fields of the schema
// (Prisma.dmmf), and lists every (model, columns) the operation touches:
//
//   create / createMany / createManyAndReturn / update / updateMany      → data keys (+ nested)
//   upsert                                                                → create and update keys
//   delete / deleteMany                                                   → the whole row ('*')
//   nested create / createMany / connectOrCreate.create / update / updateMany / upsert → the related
//   model with its data keys (recursively); nested delete / deleteMany / set / connect / disconnect →
//   the side that holds the foreign key: the related model ('*') for a one-to-many, the current
//   model's FK column for a many-to-one.
//
// Raw SQL: a statement that modifies data (INSERT / UPDATE / DELETE / MERGE / TRUNCATE / COPY / DDL)
// and names a protected table is reported with columns '*'. SELECT … FOR UPDATE is a read. A
// statement text that cannot be read is reported as touching every protected table (fail closed).
import { Prisma } from '@prisma/client';

export type Columns = readonly string[] | '*';

export interface Touch {
  model: string;
  /** Columns written, or '*' for a whole-row write (delete, FK change on the other side, raw SQL). */
  columns: Columns;
  /** 'create' for inserted rows, 'update' for changed rows, 'delete' for removed rows. */
  kind: 'create' | 'update' | 'delete';
}

interface RelationInfo {
  model: string;
  /** Scalar FK columns on the CURRENT model (many-to-one side), empty for the one-to-many side. */
  fromFields: readonly string[];
  /** On the other side: the FK columns of the TARGET model that point back here (connect / set moves them). */
  targetFromFields: readonly string[];
}

type Relations = ReadonlyMap<string, ReadonlyMap<string, RelationInfo>>;

type DmmfModel = {
  name: string;
  fields: readonly { name: string; kind: string; type: string; relationName?: string | null; relationFromFields?: readonly string[] | null }[];
};

export function buildRelations(models: readonly DmmfModel[]): Relations {
  const out = new Map<string, Map<string, RelationInfo>>();
  const byName = new Map(models.map((m) => [m.name, m]));
  for (const m of models) {
    const rels = new Map<string, RelationInfo>();
    for (const f of m.fields) {
      if (f.kind !== 'object') continue;
      const back = byName.get(f.type)?.fields.find((x) => x.kind === 'object' && x.relationName === f.relationName && x.type === m.name && (x.name !== f.name || f.type !== m.name));
      rels.set(f.name, { model: f.type, fromFields: f.relationFromFields ?? [], targetFromFields: back?.relationFromFields ?? [] });
    }
    out.set(m.name, rels);
  }
  return out;
}

/** The relations of the generated client's schema. */
export const SCHEMA_RELATIONS: Relations = buildRelations(Prisma.dmmf.datamodel.models as unknown as DmmfModel[]);

export const WRITE_OPERATIONS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

class Walker {
  readonly touches: Touch[] = [];
  constructor(private readonly relations: Relations) {}

  private add(model: string, columns: Columns, kind: Touch['kind']) {
    this.touches.push({ model, columns, kind });
  }

  /** One row's data for `model`: its scalar keys, and the nested writes of its relation keys. */
  data(model: string, data: unknown, kind: 'create' | 'update') {
    for (const row of asList(data)) {
      if (!isObj(row)) continue;
      const rels = this.relations.get(model);
      const scalars: string[] = [];
      for (const [key, value] of Object.entries(row)) {
        const rel = rels?.get(key);
        if (!rel) {
          scalars.push(key);
          continue;
        }
        // A relation written from this row: a many-to-one writes this row's FK column(s).
        if (rel.fromFields.length) scalars.push(...rel.fromFields);
        this.nested(rel, value);
      }
      this.add(model, scalars, kind);
    }
  }

  /** Nested write operations on a relation field. */
  private nested(rel: RelationInfo, value: unknown) {
    if (!isObj(value)) return;
    const target = rel.model;
    for (const [op, arg] of Object.entries(value)) {
      switch (op) {
        case 'create':
          this.data(target, arg, 'create');
          break;
        case 'createMany':
          for (const a of asList(arg)) if (isObj(a)) this.data(target, a.data, 'create');
          break;
        case 'connectOrCreate':
          for (const a of asList(arg)) if (isObj(a)) this.data(target, a.create, 'create');
          // connecting an existing row also moves its FK when it lives on the target side
          if (!rel.fromFields.length) this.add(target, rel.targetFromFields.length ? rel.targetFromFields : '*', 'update');
          break;
        case 'update':
        case 'updateMany':
          for (const a of asList(arg)) {
            if (!isObj(a)) continue;
            this.data(target, 'data' in a && ('where' in a || Object.keys(a).length === 1) ? a.data : a, 'update');
          }
          break;
        case 'upsert':
          for (const a of asList(arg)) {
            if (!isObj(a)) continue;
            this.data(target, a.create, 'create');
            this.data(target, a.update, 'update');
          }
          break;
        case 'delete':
        case 'deleteMany':
          this.add(target, '*', 'delete');
          break;
        case 'connect':
        case 'disconnect':
        case 'set':
          // one-to-many: the FK is on the target rows; many-to-one: already counted as this row's FK.
          if (!rel.fromFields.length) this.add(target, rel.targetFromFields.length ? rel.targetFromFields : '*', 'update');
          break;
        default:
          // Unknown nested key (a future Prisma operation): fail closed on the target.
          this.add(target, '*', 'update');
      }
    }
  }
}

/** Every (model, columns) a model operation writes. Reads return []. */
export function writesOf(model: string, operation: string, args: unknown, relations: Relations = SCHEMA_RELATIONS): Touch[] {
  if (!WRITE_OPERATIONS.has(operation)) return [];
  const w = new Walker(relations);
  const a = isObj(args) ? args : {};
  switch (operation) {
    case 'create':
    case 'createMany':
    case 'createManyAndReturn':
      w.data(model, a.data, 'create');
      break;
    case 'update':
    case 'updateMany':
      w.data(model, a.data, 'update');
      break;
    case 'upsert':
      w.data(model, a.create, 'create');
      w.data(model, a.update, 'update');
      break;
    case 'delete':
    case 'deleteMany':
      w.touches.push({ model, columns: '*', kind: 'delete' });
      break;
  }
  // A create without data (all defaults) still inserts a row.
  if (!w.touches.some((t) => t.model === model) && operation !== 'delete' && operation !== 'deleteMany') {
    w.touches.push({ model, columns: [], kind: operation.startsWith('create') ? 'create' : 'update' });
  }
  return w.touches;
}

// ---------------------------------------------------------------------------------------------------
// Raw SQL
// ---------------------------------------------------------------------------------------------------

export const RAW_OPERATIONS: ReadonlySet<string> = new Set(['$executeRaw', '$executeRawUnsafe', '$queryRaw', '$queryRawUnsafe']);

/** The SQL text of a raw operation's arguments, or null when it cannot be read. */
export function rawSqlText(operation: string, args: unknown): string | null {
  if (operation.endsWith('Unsafe')) {
    const first = Array.isArray(args) ? args[0] : args;
    return typeof first === 'string' ? first : null;
  }
  // Tagged template / Prisma.sql: a Sql object (strings + values).
  if (isObj(args)) {
    if (typeof args.sql === 'string') return args.sql;
    if (Array.isArray(args.strings)) return (args.strings as unknown[]).join('?');
  }
  if (Array.isArray(args)) {
    const first = args[0];
    if (isObj(first) && Array.isArray((first as Obj).raw)) return ((first as Obj).raw as unknown[]).join('?');
    if (Array.isArray(first)) return (first as unknown[]).join('?');
  }
  return null;
}

const DML = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|COPY|ALTER|DROP|CREATE|GRANT|REVOKE)\b/i;
const ROW_LOCKS = /\bFOR\s+(NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)\b/gi;

function stripSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(ROW_LOCKS, ' ');
}

/** Whether a SQL text modifies data (after removing comments, literals and row-lock clauses). */
export function isDataModifyingSql(sql: string): boolean {
  return DML.test(stripSql(sql));
}

/**
 * The protected tables a raw statement modifies ('*'), or the protected columns it names for tables
 * protected by column. `null` text (unreadable) → every protected table (fail closed).
 */
export function rawWrites(
  sql: string | null,
  tables: readonly string[],
  columns: Readonly<Record<string, { columns: readonly string[] }>>,
): Touch[] {
  if (sql === null) return tables.map((model) => ({ model, columns: '*' as const, kind: 'update' as const }));
  const text = stripSql(sql);
  if (!DML.test(text)) return [];
  const out: Touch[] = [];
  const names = (t: string) => new RegExp(`(^|[^A-Za-z0-9_"])("${t}"|${t})(?![A-Za-z0-9_"])`, 'i');
  for (const t of tables) if (names(t).test(text)) out.push({ model: t, columns: '*', kind: 'update' });
  for (const [t, spec] of Object.entries(columns)) {
    if (!names(t).test(text)) continue;
    const hit = spec.columns.filter((c) => new RegExp(`(^|[^A-Za-z0-9_])"?${c}"?(?![A-Za-z0-9_])`, 'i').test(text));
    if (hit.length) out.push({ model: t, columns: hit, kind: 'update' });
    else if (/\b(DELETE|TRUNCATE|DROP)\b/i.test(text)) out.push({ model: t, columns: '*', kind: 'delete' });
  }
  return out;
}
