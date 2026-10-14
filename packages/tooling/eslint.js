import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { importX } from 'eslint-plugin-import-x';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const CORE_IMPORT = {
  group: ['@petalbot/core', '@petalbot/core/*'],
  message: 'Plugins talk to the core only through ctx.',
};

/** Browser code: the UI SDK, the panel and plugin panel code. */
const UI_FILES = [
  'packages/ui-sdk/src/**',
  'packages/ui-sdk/test/**',
  'packages/panel/src/**',
  'packages/panel/test/**',
  'packages/overlay-host/src/**',
  'packages/overlay-host/test/**',
  'plugins/*/src/**/*.tsx',
  'plugins/*/src/client.ts',
];

/**
 * Shared PetalBot ESLint flat config.
 * @param {{ tsconfigRootDir: string }} options
 */
export function petalbot({ tsconfigRootDir }) {
  return tseslint.config(
    {
      ignores: [
        '**/dist/**',
        '**/node_modules/**',
        '**/coverage/**',
        '.idea/**',
        '.superpowers/**',
        'packages/tooling/test/fixtures/**',
      ],
    },
    js.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        globals: globals.node,
        parserOptions: {
          // Root-level config files (vitest.config.ts) are not part of any package tsconfig.
          projectService: { allowDefaultProject: ['*.ts'] },
          tsconfigRootDir,
        },
      },
      plugins: { 'import-x': importX },
      rules: {
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-misused-promises': 'error',
        '@typescript-eslint/ban-ts-comment': [
          'error',
          { 'ts-ignore': true, 'ts-expect-error': 'allow-with-description' },
        ],
        '@typescript-eslint/consistent-type-imports': 'error',
        // ignoreExternal: the resolver crashes on the Vite and Babel typings (verified).
        'import-x/no-cycle': ['error', { ignoreExternal: true }],
      },
    },
    {
      files: ['plugins/**'],
      rules: { 'no-restricted-imports': ['error', { patterns: [CORE_IMPORT] }] },
    },
    {
      files: UI_FILES,
      ...reactHooks.configs.flat.recommended,
      languageOptions: { globals: { ...globals.node, ...globals.browser } },
    },
    {
      files: ['plugins/*/src/**/*.tsx', 'plugins/*/src/client.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              CORE_IMPORT,
              {
                group: ['**/server', '**/server.ts', '**/server/**'],
                message: 'UI code must not import the server entry; share only the contract.',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['**/*.js'],
      ...tseslint.configs.disableTypeChecked,
    },
    prettier,
  );
}
