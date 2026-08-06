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
      // 渲染层是一串 classic script，前一个文件的顶层声明对后一个是可见的。
      // 不在这里声明出来，no-undef 就会对每一次跨文件调用报错——噪音一多，
      // 真正的「用了但没 require」就被埋掉了，main.js 里那两个正是这么漏的。
      globals: {
        ...globals.browser,
        Data: 'readonly',
        formatTime: 'readonly',
        dayLabel: 'readonly',
        renderSettings: 'readonly',
        bindSettings: 'readonly',
        renderCard: 'readonly',
        CardModel: 'readonly',
        LiveCards: 'readonly',
        cardElapsedText: 'readonly',
        makeOrb: 'readonly',
        icon: 'readonly',
        esc: 'readonly',
        StageChipsPolicy: 'readonly',
      },
    },
    rules: {
      // Renderer files are deliberately loaded as classic scripts. Their
      // top-level declarations share one isolated BrowserWindow global; the
      // generic no-implicit-globals rule otherwise reports every function in
      // these files as an error without finding an actual leak.
      'no-implicit-globals': 'off',
      // 上面把跨文件可见的名字声明成了 global，定义它们的那个文件因此会被
      // 判成「重复声明」。那正是我们要的写法，所以只关掉这一项检查。
      'no-redeclare': ['error', { builtinGlobals: false }],
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
