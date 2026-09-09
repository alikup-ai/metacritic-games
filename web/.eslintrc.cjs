/**
 * ESLint для frontend.
 *
 * Отдельно от корневого: там правила для Node/TypeScript без JSX.
 */
module.exports = {
  root: true,
  extends: ['next/core-web-vitals', 'plugin:@typescript-eslint/recommended'],
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  rules: {
    // Пустые блоки catch допустимы там, где сбой намеренно поглощается
    '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none' }],
  },
  ignorePatterns: ['.next/', 'node_modules/', 'e2e/', 'next-env.d.ts'],
};
