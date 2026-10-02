// The canonical reads of the rules module (SOURCE_OF_TRUTH «القيم القانونية»): rules.valueAt(key,
// companyId, d). RuleParameter (dated, with source) is the legal value; CompanyRuleOverride layers the
// company's choice on top within the key's bound; the catalogue is the fallback when the table holds
// no version of a key.
//
// Client-safe module graph: only type imports at the top; the Prisma client is loaded lazily when the
// caller passes none. A RulesReader caches what it read, so create one per request (or per job run
// and company) and never keep it across requests: a new override must be seen by the next request.
import type { Prisma, PrismaClient } from '@prisma/client';
import { RULE_CATALOGUE } from './catalogue';
import {
  LABOR_LAW_KEYS,
  dayKey,
  laborLawFromValues,
  resolveRule,
  ruleDef,
  type LaborLaw,
  type LaborLawKey,
  type LegalVersion,
  type OverrideVersion,
  type ResolvedRuleValue,
  type RuleKey,
} from './resolve';

/** Any client that can read the two tables (root client or a transaction). */
export type RulesDb = Pick<PrismaClient | Prisma.TransactionClient, 'ruleParameter' | 'companyRuleOverride'>;

export interface RulesReader {
  /** The resolved value with its provenance (registry / catalogue / override, version, clamping). */
  ruleAt(key: RuleKey, companyId: string | null, date: Date | string): Promise<ResolvedRuleValue>;
  /** The number to use. */
  valueAt(key: RuleKey, companyId: string | null, date: Date | string): Promise<number>;
  /** The labour-law bundle for the pure helpers (leave, payroll, settlement…). */
  laborLaw(companyId: string | null, date: Date | string): Promise<LaborLaw>;
  /**
   * DEC-PO-126: the values of `companyId` on `date` that come from an acknowledged override outside
   * the legal bound (`belowLegal: true`), for the warning on pay / leave / settlement screens.
   */
  belowLegal(companyId: string, date: Date | string): Promise<ResolvedRuleValue[]>;
}

function toDay(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** A per-request reader: each key's registry rows and each company's overrides are read once. */
export function createRulesReader(db: RulesDb): RulesReader {
  const registry = new Map<string, Promise<LegalVersion[]>>();
  const overrides = new Map<string, Promise<Map<string, OverrideVersion[]>>>();

  const legalRows = (keys: readonly string[]): Promise<void> => {
    const missing = keys.filter((k) => !registry.has(k));
    if (!missing.length) return Promise.resolve();
    const all = db.ruleParameter.findMany({
      where: { key: { in: missing } },
      select: { id: true, key: true, value: true, effectiveFrom: true, effectiveTo: true, status: true, sourceUrl: true },
      orderBy: [{ key: 'asc' }, { effectiveFrom: 'asc' }],
    });
    for (const k of missing) {
      registry.set(
        k,
        all.then((rows) =>
          rows
            .filter((r) => r.key === k)
            .map((r) => ({ id: r.id, effectiveFrom: toDay(r.effectiveFrom)!, effectiveTo: toDay(r.effectiveTo), value: r.value, status: r.status, sourceUrl: r.sourceUrl })),
        ),
      );
    }
    return all.then(() => undefined);
  };

  const companyOverrides = (companyId: string): Promise<Map<string, OverrideVersion[]>> => {
    let p = overrides.get(companyId);
    if (!p) {
      p = db.companyRuleOverride
        .findMany({
          where: { companyId, revokedAt: null },
          select: { id: true, key: true, value: true, effectiveFrom: true, effectiveTo: true, belowLegalAckAt: true },
        })
        .then((rows) => {
          const m = new Map<string, OverrideVersion[]>();
          for (const r of rows) {
            const list = m.get(r.key) ?? [];
            list.push({ id: r.id, effectiveFrom: toDay(r.effectiveFrom)!, effectiveTo: toDay(r.effectiveTo), value: r.value, revoked: false, belowLegalAck: r.belowLegalAckAt != null });
            m.set(r.key, list);
          }
          return m;
        });
      overrides.set(companyId, p);
    }
    return p;
  };

  const ruleAt = async (key: RuleKey, companyId: string | null, date: Date | string): Promise<ResolvedRuleValue> => {
    ruleDef(key);
    const day = dayKey(date);
    await legalRows([key]);
    const [legal, ov] = await Promise.all([registry.get(key)!, companyId ? companyOverrides(companyId) : Promise.resolve(null)]);
    return resolveRule(key, day, legal, ov?.get(key) ?? []);
  };

  return {
    ruleAt,
    valueAt: async (key, companyId, date) => (await ruleAt(key, companyId, date)).value,
    laborLaw: async (companyId, date) => {
      await legalRows(LABOR_LAW_KEYS);
      const values = new Map<LaborLawKey, number>();
      await Promise.all(LABOR_LAW_KEYS.map(async (k) => values.set(k, (await ruleAt(k, companyId, date)).value)));
      return laborLawFromValues((k) => values.get(k)!);
    },
    belowLegal: async (companyId, date) => {
      const keys = [...(await companyOverrides(companyId)).keys()].filter((k) => RULE_CATALOGUE.some((d) => d.key === k)) as RuleKey[];
      if (!keys.length) return [];
      await legalRows(keys);
      const all = await Promise.all(keys.map((k) => ruleAt(k, companyId, date)));
      return all.filter((r) => r.belowLegal);
    },
  };
}

async function defaultDb(): Promise<RulesDb> {
  return (await import('@/lib/prisma')).prisma;
}

/**
 * THE reader of a regulatory value (SOURCE_OF_TRUTH): the company override in force on `date` when
 * there is one (past the legal bound only when acknowledged, DEC-PO-126: ruleAt says `belowLegal`),
 * else the RuleParameter version in force. One call reads
 * the database; for several values in one request use createRulesReader(db).
 */
export async function valueAt(key: RuleKey, companyId: string | null, date: Date | string, db?: RulesDb): Promise<number> {
  return createRulesReader(db ?? (await defaultDb())).valueAt(key, companyId, date);
}

/** valueAt with provenance (for explanations and snapshots, INV-RULE-01). */
export async function ruleAt(key: RuleKey, companyId: string | null, date: Date | string, db?: RulesDb): Promise<ResolvedRuleValue> {
  return createRulesReader(db ?? (await defaultDb())).ruleAt(key, companyId, date);
}

/** The labour-law bundle of `companyId` on `date` (registry + override). */
export async function laborLawFor(db: RulesDb | null | undefined, companyId: string | null, date: Date | string): Promise<LaborLaw> {
  return createRulesReader(db ?? (await defaultDb())).laborLaw(companyId, date);
}

/** Overrides of a company (active and revoked), for the settings screen and the audit view. */
export async function companyRuleOverrides(db: RulesDb, companyId: string) {
  return db.companyRuleOverride.findMany({
    where: { companyId },
    orderBy: [{ key: 'asc' }, { effectiveFrom: 'asc' }],
  });
}
