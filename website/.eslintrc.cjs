// Correctness-focused: catches undefined names, unused code and hook-rule
// violations without imposing a style on the existing components.
module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
  settings: { react: { version: '18.2' } },
  plugins: ['react', 'react-hooks'],
  extends: ['eslint:recommended', 'plugin:react/recommended', 'plugin:react/jsx-runtime', 'plugin:react-hooks/recommended'],
  ignorePatterns: ['dist', 'node_modules'],
  rules: {
    'react/prop-types': 'off',
    'react/no-unescaped-entities': 'off',
    // React 18.2 doesn't know fetchPriority yet; the lowercase attribute is
    // passed straight through to the <img>, which is what we want.
    'react/no-unknown-property': ['error', { ignore: ['fetchpriority'] }],
    // `import React` is still the house style even with the automatic runtime.
    'no-unused-vars': ['error', { varsIgnorePattern: '^(_|React$)', argsIgnorePattern: '^_', caughtErrors: 'none' }],
    'no-empty': ['error', { allowEmptyCatch: true }],
  },
  overrides: [
    { files: ['test/**', '*.config.js'], env: { node: true } },
    // AdminPortal is owned by the admin workstream and predates this config;
    // its existing hook-deps/unused-arg findings are left to that work.
    {
      files: ['src/components/AdminPortal.jsx'],
      rules: { 'react-hooks/exhaustive-deps': 'off', 'no-unused-vars': 'off' },
    },
  ],
};
