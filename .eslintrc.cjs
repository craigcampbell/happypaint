module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', 'mobile', '.eslintrc.cjs'],
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  settings: { react: { version: '18.2' } },
  plugins: ['react-refresh'],
  rules: {
    'react/prop-types': 'off',
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
  },
  overrides: [
    {
      // Server-side and build/prep code (the realtime server, moderation
      // modules, and scripts/) runs in Node, not the browser, so it uses Node
      // globals like `process`.
      files: ['server.js', 'server/**/*.js', 'scripts/**/*.{js,mjs}'],
      env: { node: true, browser: false },
    },
  ],
}
