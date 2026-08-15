import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/core/src/**/*.ts'],
      exclude: ['**/index.ts', '**/types.ts'],
      // Doc 07 §5: these three modules carry the product's correctness.
      thresholds: {
        'packages/core/src/scoring/**': { branches: 90, functions: 95, lines: 95 },
        'packages/core/src/confidence/**': { branches: 90, functions: 95, lines: 95 },
        'packages/core/src/recommendation/**': { branches: 90, functions: 95, lines: 95 },
      },
    },
  },
  resolve: {
    alias: {
      '@core': new URL('./packages/core/src', import.meta.url).pathname,
    },
  },
});
