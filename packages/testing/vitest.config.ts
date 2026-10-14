import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'testing',
    include: ['test/**/*.test.ts'],
  },
});
