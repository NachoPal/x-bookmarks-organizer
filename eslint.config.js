// Flat ESLint config (ESLint 9+).
const tseslint = require('@typescript-eslint/eslint-plugin');
const tsparser = require('@typescript-eslint/parser');

module.exports = [
  {
    // `vendor/` is third-party code copied in verbatim (see AGENTS.md); it is
    // re-vendored by copying, never edited, so linting it would only ever
    // report someone else's minified style.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'src/web/public/vendor/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // The viewer's browser modules ship as plain <script> files, so `tsc`
    // never sees them and nothing else would notice a call to a function that
    // no longer exists. That is exactly how `releaseOrphanPanes` survived its
    // own deletion and silently broke both the post-ranking refresh and the
    // sort-order switch (issue #91), so `no-undef` is the gate that keeps it
    // from happening again.
    files: ['src/web/public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      // Spelled out rather than pulled from the `globals` package, which is
      // only a transitive dependency of ESLint here: the viewer's modules
      // touch a small, deliberately boring slice of the platform, and a name
      // that is genuinely missing should surface as a `no-undef` to think
      // about rather than be waved through by a blanket browser preset.
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        location: 'readonly',
        navigator: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        queueMicrotask: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
        IntersectionObserver: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        AbortController: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Node: 'readonly',
        HTMLElement: 'readonly',
        getComputedStyle: 'readonly',
        matchMedia: 'readonly',
        // The modules are dual-target: a <script> in the viewer, a `require`
        // in their colocated Vitest tests.
        module: 'readonly',
        require: 'readonly',
        globalThis: 'readonly',
        // `render-markdown.js` publishes this one as a bare global rather
        // than under an `XBO*` namespace (see its tail), so app.js calls it
        // by name instead of through `window.XBO*`.
        renderSummaryMarkdown: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },
];
