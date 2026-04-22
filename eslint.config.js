// @ts-check
// ESLint 9 flat config. Intentionally minimal:
// - Parses TypeScript via @typescript-eslint/parser
// - Does not enable typed-linting rules (avoids the `project: ./tsconfig.json`
//   slowdown and its cold-start failure modes on CI)
// - Relies on `npm run build` (tsc --noEmit via the main build step) for
//   type-level correctness; this config only catches syntax and obvious smells.

import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '_plans/**', 'docs/benchmarks/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        NodeJS: 'readonly',
        globalThis: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      // Core hygiene
      'no-unused-vars': 'off', // Handled by the TS rule below
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-undef': 'off', // TS handles this
      'no-console': 'off',
      'prefer-const': 'warn',
      'no-var': 'error',
      eqeqeq: ['warn', 'smart'],
      // TS-specific
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
