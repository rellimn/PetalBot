import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'sdk',
    include: ['test/**/*.test.ts'],
    typecheck: { enabled: true, include: ['test/**/*.test-d.ts'], tsconfig: './tsconfig.json' },
  },
});
