import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'twitch', include: ['test/**/*.test.{ts,tsx}'] },
});
