// Architecture conformance (ARCHITECTURE_INVARIANTS §4.1, package P1-FND-ARCH).
//
// Runs every ARCH rule of rules.ts over the repository and compares the result with the ratchet
// baseline (baseline.json in this folder, §4.1.3):
//   - a NEW violation fails, with rule id, file:line and what to do;
//   - a FIXED violation still counted in the baseline fails too, until the baseline is shrunk.
//
// Commands:
//   npm run arch:baseline                     shrink the baseline to what is left (never adds)
//   npm run arch:baseline -- --grow ADR-00xx  add entries; needs an existing ADR in docs/architecture/decisions
//   ARCH_BASELINE_REF=origin/master npx vitest run src/test/architecture
//                                             also checks the baseline did not grow against that git ref
//                                             (default ref: HEAD; skipped when the file is not in git yet)
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Baseline, allowed, compare, countByKey, formatFailure, grow, shrink, totals, unexplainedGrowth } from './ratchet';
import { RULES, type Violation } from './rules';
import { ROOT, loadProject } from './source';

const BASELINE_PATH = join(__dirname, 'baseline.json');
const BASELINE_REL = 'src/test/architecture/baseline.json';

const ABOUT = [
  'Ratchet baseline of ARCHITECTURE_INVARIANTS §4.1.3: inherited violations as { rule: { file: count } }.',
  'It may only shrink. After fixing violations run `npm run arch:baseline` (shrink only).',
  'Adding an entry needs an ADR: `npm run arch:baseline -- --grow ADR-00xx` logs it under "growth".',
  'allowances: standing exceptions granted by an ADR for a tagged pattern under a path prefix.',
];

const DEFAULT_ALLOWANCES: Baseline['allowances'] = [
  {
    rule: 'ARCH-003',
    tag: 'employment-state-fallback',
    pathPrefix: 'src/modules/lifecycle/',
    adr: 'ADR-0002 #5',
    until: 'Release C (LCY-M2)',
    note: 'employmentState ?? (isTerminated…) fallback (BR-LCY-013) inside lifecycle readers only',
  },
];

function readBaseline(): Baseline | null {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
}

function writeBaseline(b: Baseline) {
  const { rules, allowances, growth } = b;
  writeFileSync(BASELINE_PATH, JSON.stringify({ _about: ABOUT, rules, allowances, growth }, null, 2) + '\n');
}

const results = new Map<string, Violation[]>();
let baseline: Baseline;

beforeAll(() => {
  const project = loadProject();
  const existing = readBaseline();
  const allowances = existing?.allowances ?? DEFAULT_ALLOWANCES;
  for (const rule of RULES) results.set(rule.id, rule.run(project).filter((x) => !allowed(x, allowances)));
  const actual: Record<string, Record<string, number>> = {};
  for (const [id, vs] of results) if (vs.length) actual[id] = countByKey(vs);

  const mode = process.env.ARCH_BASELINE;
  if (mode === 'init') {
    if (existing) throw new Error('baseline.json exists; init is only for creating it. Use shrink (default) or --grow ADR-00xx.');
    writeBaseline({ rules: actual, allowances, growth: [] });
  } else if (mode === 'shrink') {
    if (!existing) throw new Error('baseline.json is missing');
    writeBaseline(shrink(existing, actual));
  } else if (mode === 'grow') {
    const adr = process.env.ARCH_BASELINE_ADR ?? '';
    const m = /^ADR-(\d{4})$/.exec(adr);
    const decisions = join(ROOT, 'docs', 'architecture', 'decisions');
    if (!m || !readdirSync(decisions).some((f) => f.startsWith(`${adr}-`) || f === `${adr}.md`)) {
      throw new Error(`--grow needs an existing ADR id (docs/architecture/decisions/ADR-xxxx-*.md), got "${adr}"`);
    }
    if (!existing) throw new Error('baseline.json is missing');
    writeBaseline(grow(existing, actual, adr, new Date().toISOString().slice(0, 10)));
  }
  const b = readBaseline();
  if (!b) throw new Error(`${BASELINE_REL} is missing. Create it once with ARCH_BASELINE=init.`);
  baseline = b;
  if (mode) {
    const t = totals(baseline);
    console.log(`[arch] baseline written (${mode}): ${Object.entries(t).map(([r, n]) => `${r}=${n}`).join(', ') || 'empty'}`);
  }
}, 120_000); // parsing the whole repository takes a few seconds

describe('architecture conformance (ARCH ratchet, §4.1.3)', () => {
  for (const rule of RULES) {
    it(`${rule.id}: ${rule.title}`, () => {
      const c = compare(rule.id, results.get(rule.id) ?? [], baseline);
      if (c.grown.length || c.stale.length) expect.fail(`${formatFailure(rule, c)}\n\nChecked: ${rule.check}`);
    });
  }

  it('ARCH-018 is covered by the job-timer test', () => {
    // The timers themselves are compared in src/lib/__tests__/ops-job-timers.test.ts (not duplicated here).
    expect(existsSync(join(ROOT, 'src', 'lib', '__tests__', 'ops-job-timers.test.ts'))).toBe(true);
  });

  it('the baseline names only known rules and positive counts', () => {
    const known = new Set(RULES.map((r) => r.id));
    for (const [rule, entries] of Object.entries(baseline.rules)) {
      expect(known.has(rule), `unknown rule ${rule} in baseline.json`).toBe(true);
      for (const [key, n] of Object.entries(entries)) expect(Number.isInteger(n) && n > 0, `${rule} ${key}: ${n}`).toBe(true);
    }
  });

  it('the baseline did not grow without an ADR (against git)', () => {
    const ref = process.env.ARCH_BASELINE_REF ?? 'HEAD';
    let prevText: string;
    try {
      prevText = execFileSync('git', ['show', `${ref}:${BASELINE_REL}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return; // not committed yet at that ref (first introduction) or no git: nothing to compare
    }
    const prev = JSON.parse(prevText) as Baseline;
    const grownKeys = unexplainedGrowth(prev, baseline);
    expect(grownKeys, `baseline grew against ${ref} without an ADR growth entry:\n${grownKeys.join('\n')}`).toEqual([]);
    const prevAllow = new Set(prev.allowances.map((a) => JSON.stringify(a)));
    const newAllow = baseline.allowances.filter((a) => !prevAllow.has(JSON.stringify(a)) && !/^ADR-\d{4}/.test(a.adr));
    expect(newAllow, 'a new allowance must name its ADR').toEqual([]);
  });
});
