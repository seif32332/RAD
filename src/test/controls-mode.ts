// The controls mode in tests (BL-PAY-021). The mode is computed per legal company from the tenant's attested
// approvers and Radeef's readiness mark (iam), and the IT suites share ONE database whose users come and go with
// every file, so the computed mode of the shared database is meaningless for a test. src/test/setup-controls-mode.ts
// (a vitest setupFile) therefore replaces platform's resolveOperatorMode in every test file with this switch:
//
//   ENFORCED (default)  every two-person condition applies (what every test assumed before BL-PAY-021);
//   SINGLE_OPERATOR     a test of the single-operator path (every company);
//   COMPUTED            the real resolver (iam: readiness + count per company), for a test that owns its database
//                       (the BL-PAY-021 acceptance tenants) or that stubs the db it passes;
//   { [companyId]: mode }  per company (others: ENFORCED).
// An act whose company is unknown is ENFORCED whatever the switch says (as in production).
//
// Application code never imports this file (money-gateway-static.test.ts refuses src/test imports from
// src/app, src/lib, src/modules and src/jobs), so production has no override: only the computed mode.
export type TestMode = 'ENFORCED' | 'SINGLE_OPERATOR' | 'COMPUTED';
export type TestControlsMode = TestMode | Readonly<Record<string, TestMode>>;

const KEY = '__radeefTestControlsMode';
type Holder = { [KEY]?: TestControlsMode };

export function testControlsMode(): TestControlsMode {
  return (globalThis as Holder)[KEY] ?? 'ENFORCED';
}

/** The switch's mode for one company. */
export function testControlsModeOf(companyId: string): TestMode {
  const m = testControlsMode();
  return typeof m === 'string' ? m : (m[companyId] ?? 'ENFORCED');
}

export function setTestControlsMode(mode: TestControlsMode): void {
  (globalThis as Holder)[KEY] = mode;
}

/** Runs `fn` with the given mode, then restores the previous one (sequential tests only). */
export async function withControlsMode<T>(mode: TestControlsMode, fn: () => Promise<T>): Promise<T> {
  const prev = testControlsMode();
  setTestControlsMode(mode);
  try {
    return await fn();
  } finally {
    setTestControlsMode(prev);
  }
}
