import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // The codebase has no explicit `any` left; keep it that way.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // ARCH-001 (docs/architecture/ARCHITECTURE_INVARIANTS.md §4.1): a module is used only through its
    // public interface src/modules/<m>/index.ts. Inside a module, import its own files relatively.
    // The full check (cross-module reads, dependency direction) is src/test/architecture.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/__tests__/**", "src/**/*.test.ts", "src/test/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/modules/*/*", "!@/modules/*/index", "**/modules/*/*", "!**/modules/*/index"],
              message: 'ARCH-001: import a module through its index ("@/modules/<m>"); inside the module use relative imports.',
            },
          ],
        },
      ],
    },
  },
  {
    // Node CommonJS config files at the repo root.
    files: ["*.config.js", "ecosystem.config.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Project ignores:
    "node_modules/**",
    "coverage/**",
    // Generated background-jobs bundle (scripts/build-jobs.mjs).
    "dist/**",
    "ops/legacy/**",
    "docs/**",
    "radeef-manage/**",
    "prisma/migrations/**",
    "uploads/**",
    "public/uploads/**",
    // Python face verification service (its own tests; a local .venv must not be linted).
    "services/**",
  ]),
]);

export default eslintConfig;
