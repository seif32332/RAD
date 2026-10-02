#!/usr/bin/env node
// Update the architecture ratchet baseline (src/test/architecture/baseline.json,
// ARCHITECTURE_INVARIANTS §4.1.3). Tooling only: it runs the conformance test in "write" mode.
//
//   npm run arch:baseline                      shrink: counts drop to what is left, entries never added
//   npm run arch:baseline -- --grow ADR-0003   add/raise entries; the ADR must exist in
//                                              docs/architecture/decisions/ and every increase is
//                                              logged in baseline.json "growth"
//   npm run arch:baseline -- --init            create the file (only when it does not exist)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const env = { ...process.env, ARCH_BASELINE: 'shrink' };
if (args[0] === '--grow') {
  if (!args[1]) {
    console.error('usage: npm run arch:baseline -- --grow ADR-00xx');
    process.exit(2);
  }
  env.ARCH_BASELINE = 'grow';
  env.ARCH_BASELINE_ADR = args[1];
} else if (args[0] === '--init') {
  env.ARCH_BASELINE = 'init';
} else if (args.length) {
  console.error(`unknown argument ${args[0]}`);
  process.exit(2);
}

const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const r = spawnSync(process.execPath, [vitest, 'run', 'src/test/architecture/conformance.arch.test.ts'], { stdio: 'inherit', env });
if (r.status !== 0) {
  console.error('\nThe baseline was updated where allowed; the failures above are violations it may not absorb.');
}
process.exit(r.status ?? 1);
