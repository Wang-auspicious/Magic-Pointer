import globals from 'globals';
import js from '@eslint/js';

export default [
  {
    ignores: [
      'node_modules/**',
      'release/**',
      'build/**',
      'external/**',
      'external_zip/**',
      'data/**',
      'app/**',
      'electron/renderer/assets/**',
      '.tmp/**',
      '.tmp*/**',
      '.pytest*/**',
      '.pytest_cache/**',
    ],
  },
  {
    ...js.configs.recommended,
    files: ['electron/**/*.js', 'scripts/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-console': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-prototype-builtins': 'off',
      eqeqeq: ['warn', 'smart'],
      'no-implicit-globals': 'error',
      'no-restricted-globals': ['error', 'event', 'name'],
    },
  },
  {
    files: ['electron/renderer/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
    rules: {
      // Renderer files are deliberately loaded as classic scripts. Their
      // top-level declarations share one isolated BrowserWindow global; the
      // generic no-implicit-globals rule otherwise reports every function in
      // these files as an error without finding an actual leak.
      'no-implicit-globals': 'off',
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: ['electron/route_policy.js', 'electron/renderer/stage.js'],
    rules: {
      // These expressions intentionally reject C0 control characters in URLs
      // and inserted text. The control range is the security check itself.
      'no-control-regex': 'off',
    },
  },
];
