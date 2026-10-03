// vitest setupFile (vitest.config.ts): see src/test/controls-mode.ts. Every test file gets platform's
// controls-mode resolver behind the test switch; the registration of the real resolver (iam) still runs.
// Like production, an act whose company is unknown is ENFORCED whatever the switch says.
import { vi } from 'vitest';
import { testControlsModeOf } from './controls-mode';

vi.mock('@/modules/platform/controls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/platform/controls')>();
  return {
    ...actual,
    resolveOperatorMode: async (db: Parameters<typeof actual.resolveOperatorMode>[0], companyId: string | null | undefined) => {
      if (typeof companyId !== 'string' || !companyId) return 'ENFORCED';
      const mode = testControlsModeOf(companyId);
      return mode === 'COMPUTED' ? actual.resolveOperatorMode(db, companyId) : mode;
    },
  };
});
