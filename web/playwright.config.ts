import { defineConfig, devices } from '@playwright/test';

/**
 * Конфигурация E2E.
 *
 * Поднимаются два процесса: поддельный бэкенд и Next.js в рабочем режиме.
 * Внешние сервисы не используются — ни Metacritic, ни OpenRouter.
 *
 * Проверяется собранное приложение, а не режим разработки: в нём иные
 * оптимизации и поведение кеша.
 */
const MOCK_PORT = 3101;
const WEB_PORT = 3100;
/** Экземпляр с заведомо недоступным бэкендом. */
const FAILING_PORT = 3102;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'list' : [['list']],
  timeout: 30_000,

  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
  },

  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // Мобильный размер: проверяется, что разметка не разъезжается
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],

  webServer: [
    {
      command: `node e2e/mock-api.mjs`,
      port: MOCK_PORT,
      reuseExistingServer: false,
      env: { MOCK_API_PORT: String(MOCK_PORT) },
    },
    {
      command: `npm run start -- -p ${WEB_PORT}`,
      port: WEB_PORT,
      reuseExistingServer: false,
      env: {
        API_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
        NODE_ENV: 'production',
      },
    },
    {
      // Второй экземпляр направлен на закрытый порт: так проверяется
      // поведение при недоступном бэкенде.
      command: `npm run start -- -p ${FAILING_PORT}`,
      port: FAILING_PORT,
      reuseExistingServer: false,
      env: {
        API_BASE_URL: 'http://127.0.0.1:3199',
        NODE_ENV: 'production',
      },
    },
  ],
});
