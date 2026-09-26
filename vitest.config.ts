/**
 * Unit tests (yourphr#610): one spec per manager and provider in a `__tests__` folder beside it, the layout
 * ngdpbase uses. Managers are tested over in-memory fakes of their provider interfaces; providers
 * over a temp file. The hand-rolled harnesses in scripts/ are integration tests and stay separate
 * (`npm run <name>`); this is `npm test`.
 *
 * Coverage floors apply to the framework and the application halves — the code written under
 * #608's rules. The transitional stores (src/auth, src/worker, …) are excluded until their child
 * converts them; adding a floor to code nobody has tested yet only teaches people to lower it.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // scripts/__tests__: the release tooling's pure functions (scripts/version.ts), unit-tested like
    // any module. The scripts/*-tests.ts harnesses are still integration runs, not included here.
    include: ['src/**/__tests__/**/*.test.ts', 'scripts/__tests__/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/framework/**/*.ts', 'src/app/**/*.ts'],
      exclude: ['**/__tests__/**'],
      reporter: ['text', 'lcov'],
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
    },
  },
});
