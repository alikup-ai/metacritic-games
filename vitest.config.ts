import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // tests/live НАМЕРЕННО исключён: эти тесты обращаются к реальному
    // Metacritic и не должны выполняться в обычном прогоне и в CI.
    // Запуск: npm run test:metacritic-live
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // Интеграционные тесты работают с общей БД — параллельные файлы
    // мешали бы друг другу, поэтому запускаем последовательно.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
