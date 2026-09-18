import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import next from '@next/eslint-plugin-next';

/**
 * `npm run lint` existed from the first commit and had never once run: there
 * was no config file, so ESLint exited with "couldn't find an
 * eslint.config.js" every time. A lint script that cannot lint is worse than
 * no script, because it reads as a check that passed.
 *
 * Deliberately small. The rules here are the ones that catch mistakes this
 * project actually made, not a style sweep that would bury them in noise.
 */
export default tseslint.config(
  // postcss.config.mjs and the test stub are plain JS outside the TS project;
  // the type-aware rules cannot parse them and have nothing to say about them.
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'docs/**',
      'next-env.d.ts',
      'postcss.config.mjs',
      'test/stubs/**',
      'eslint.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { '@next/next': next },
    rules: {
      ...next.configs.recommended.rules,

      // An unawaited promise is how a stage's work escapes the try/catch that
      // was supposed to report it failing.
      '@typescript-eslint/no-floating-promises': 'error',

      // `any` defeats the schemas that are this project's single source of
      // truth. A warning, not an error: the test fixtures use it deliberately.
      '@typescript-eslint/no-explicit-any': 'warn',

      // An unused variable is usually a rename that half-happened.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
);
