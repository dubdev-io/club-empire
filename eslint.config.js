import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage'] },
  js.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    // Type-checked rules are scoped to TypeScript files. Applied globally they
    // also hit `eslint.config.js`, which has no type information, and ESLint
    // then fails to load the rule at all rather than skipping the file.
    extends: [tseslint.configs.recommendedTypeChecked],

    // Registered by hand rather than via `reactHooks.configs['recommended-latest']`:
    // that preset ships `plugins` as an array, which ESLint 10 flat config
    // rejects. These are the two rules that matter for this codebase.
    plugins: { 'react-hooks': reactHooks },

    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },

    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // Indexing a `Float32Array` or a fixed-size sprite pool in the hot path
      // is in range by construction, and `noUncheckedIndexedAccess` makes
      // every such read need an assertion. The alternative is a bounds check
      // per guest per tick.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  {
    // Build and lint config files run in Node, not the browser.
    files: ['*.config.{ts,js}', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },

  {
    // `tools/` holds Node CLI scripts (see tools/tsconfig.json). They run in
    // Node, and printing a report to stdout is the entire point of them.
    files: ['tools/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },

  {
    files: ['**/*.test.ts'],
    rules: {
      // Test fixtures deliberately feed malformed data into the save codec.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
);
