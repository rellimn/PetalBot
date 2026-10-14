import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'create-plugin',
    include: ['test/**/*.test.ts'],
    // The gate test typechecks, lints, tests and builds three scaffolded plugins.
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
