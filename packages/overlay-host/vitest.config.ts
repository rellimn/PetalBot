import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'overlay-host',
    environment: 'happy-dom',
    // Overlay stylesheets are <link> elements; happy-dom must not fetch them.
    environmentOptions: {
      happyDOM: {
        settings: { disableCSSFileLoading: true, handleDisabledFileLoadingAsSuccess: true },
      },
    },
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
  },
});
