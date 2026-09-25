import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests for the pure domain helpers in src/lib (no database, no Next.js runtime).
export default defineConfig({
  resolve: {
    alias: [
      { find: /^server-only$/, replacement: fileURLToPath(new URL('./src/test/server-only-stub.ts', import.meta.url)) },
      { find: /^@\//, replacement: fileURLToPath(new URL('./src/', import.meta.url)) },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Tests pass explicit `now` values; pin the zone so accidental local-time usage shows up.
    env: { TZ: 'UTC' },
  },
});
