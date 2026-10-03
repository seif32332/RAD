// Test-only helpers: reset the registries between tests. Never exported from index.ts (production code cannot
// override a port or an adapter once registered).
import { resetAdapterRegistry } from './adapters';
import { resetPortRegistry } from './ports';

export function resetWorkflowRegistries(): void {
  resetAdapterRegistry();
  resetPortRegistry();
}
