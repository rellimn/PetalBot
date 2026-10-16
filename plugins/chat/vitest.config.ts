import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'chat',
    include: ['test/**/*.test.{ts,tsx}'],
    typecheck: { enabled: true, include: ['test/**/*.test-d.ts'], tsconfig: './tsconfig.json' },
  },
});
