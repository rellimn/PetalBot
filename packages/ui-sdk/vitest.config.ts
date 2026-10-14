import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'ui-sdk',
    environment: 'happy-dom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    typecheck: { enabled: true, include: ['test/**/*.test-d.ts'], tsconfig: './tsconfig.json' },
  },
});
