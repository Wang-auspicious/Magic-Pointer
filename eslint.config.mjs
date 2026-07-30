import globals from 'globals';
import js from '@eslint/js';

export default [
  js.configs.recommended,
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
    ],
  },
  {
    files: ['electron/**/*.js', 'scripts/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
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
      'no-unused-vars': 'warn',
    },
  },
];
