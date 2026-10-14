import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'panel',
    environment: 'happy-dom',
    // Plugin stylesheets are <link> elements; happy-dom must not fetch them.
    environmentOptions: {
      happyDOM: {
        settings: {
          disableCSSFileLoading: true,
          handleDisabledFileLoadingAsSuccess: true,
          // The overlay preview is an <iframe>; tests check its attributes, not its page.
          disableIframePageLoading: true,
        },
      },
    },
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
  },
});
