import { defineConfig } from 'vitest/config';

/**
 * Конфигурация ТОЛЬКО для live-тестов, обращающихся к реальному Metacritic.
 * Требует сеть. В CI не используется.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/live/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
