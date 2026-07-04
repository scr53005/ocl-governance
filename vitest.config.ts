import { defineConfig } from 'vitest/config';

// One command runs the WHOLE suite: `npm test` (= `vitest run`).
// The include globs pick up any *.test.ts under src/ or tests/ automatically,
// so new test files never need to be registered by hand. Keep tested lib files
// on RELATIVE imports (not the `@/` alias) — Vitest resolves via Node, not the
// Next bundler, so `@/…` would fail to resolve at test runtime.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
});
