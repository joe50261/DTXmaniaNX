// Minimal ESLint config — only enforces the filename and folder
// conventions documented in `web/CLAUDE.md`. General code style is
// left to TypeScript / vitest + reviewer judgement to keep this
// config tight (and the install footprint small).

import checkFile from 'eslint-plugin-check-file';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/coverage/**',
      '**/*.config.js',
      '**/*.config.cjs',
      '**/*.config.mjs',
    ],
  },
  {
    files: ['packages/*/src/**/*.{ts,tsx,js}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: { 'check-file': checkFile },
    rules: {
      'check-file/filename-naming-convention': [
        'error',
        {
          // Source files: kebab-case, optionally `.test`/`.spec`
          // suffix. Matches `song-select-canvas.ts`,
          // `song-select-canvas.test.ts`,
          // `song-wheel-model.ts`, `vr-config.ts`, etc. The fs/
          // backend folder uses `handle-store.ts`-style names that
          // also fit the same kebab-case rule.
          '**/*.{ts,tsx,js}': 'KEBAB_CASE',
        },
        {
          ignoreMiddleExtensions: true,
        },
      ],
      'check-file/folder-naming-convention': [
        'error',
        {
          'packages/*/src/**': 'KEBAB_CASE',
        },
      ],
    },
  },
];
