import { expect, test } from '@playwright/test';

/**
 * Страница мониторинга.
 *
 * Бэкенд подменён: обработчик числится работающим, есть один идущий
 * запуск и один завершённый. Реальные сервисы не вызываются.
 */

const COMPLETED_RUN = 'bbbbbbbb-2222-4222-8222-222222222222';

test.describe('Мониторинг', () => {
  test('открывается и показывает состояние обработчика', async ({ page }) => {
    await page.goto('/monitoring');

    await expect(page.getByRole('heading', { name: 'Мониторинг обработки' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Обработчик' })).toBeVisible();
    // Обработчик работает — это должно быть видно сразу
    await expect(page.getByText('выполняется').first()).toBeVisible();
  });

  test('показывает время последнего отклика', async ({ page }) => {
    await page.goto('/monitoring');

    const list = page.locator('.definition-list').first();
    await expect(list).toContainText('Последний отклик');
    // Свежесть важнее точного времени
    await expect(list).toContainText('назад');
  });

  test('показывает историю запусков', async ({ page }) => {
    await page.goto('/monitoring');

    const table = page.locator('.platform-table');
    await expect(table).toBeVisible();
    await expect(table).toContainText('завершён');
    await expect(table).toContainText('вручную');
    await expect(table).toContainText('по расписанию');
  });

  test('открывает детали запуска', async ({ page }) => {
    await page.goto('/monitoring');

    await page.getByRole('link', { name: /\d{2}\.\d{2}/ }).first().click();

    await expect(page).toHaveURL(/\/monitoring\/runs\//);
    await expect(page.getByRole('heading', { name: /Запуск от/ })).toBeVisible();
  });

  test('детали запуска показывают стадии обработки', async ({ page }) => {
    await page.goto(`/monitoring/runs/${COMPLETED_RUN}`);

    await expect(page.getByRole('heading', { name: 'Стадии обработки' })).toBeVisible();

    // Внутренние идентификаторы стадий заменены понятными названиями
    const table = page.locator('.platform-table').last();
    await expect(table).toContainText('Данные игры');
    await expect(table).toContainText('Отзывы');
    await expect(table).toContainText('Разбор отзывов');
    await expect(table).not.toContainText('fetchGame');
  });

  test('детали запуска показывают итоги', async ({ page }) => {
    await page.goto(`/monitoring/runs/${COMPLETED_RUN}`);

    const list = page.locator('.definition-list').first();
    await expect(list).toContainText('Взято в работу');
    await expect(list).toContainText('Полностью успешно');
    await expect(list).toContainText('С ошибками');
  });

  test('несуществующий запуск даёт страницу «не найдено»', async ({ page }) => {
    await page.goto('/monitoring/runs/99999999-9999-4999-8999-999999999999');
    await expect(page.getByRole('heading', { name: 'Страница не найдена' })).toBeVisible();
  });

  test('кнопка запуска присутствует', async ({ page }) => {
    await page.goto('/monitoring');
    await expect(page.getByRole('button', { name: /Запустить обработку/ })).toBeVisible();
  });

  test('кнопка недоступна, пока обработка идёт', async ({ page }) => {
    await page.goto('/monitoring');
    // Второй запуск не создаётся: обработчик уже работает
    await expect(page.getByRole('button', { name: /Запустить обработку/ })).toBeDisabled();
  });

  test('секреты в браузер не попадают', async ({ page }) => {
    await page.goto('/monitoring');

    const html = await page.content();
    expect(html).not.toContain('x-admin-token');
    expect(html).not.toContain('ADMIN_TOKEN');
    // Адрес бэкенда клиенту неизвестен
    expect(html).not.toContain('3101');
  });

  test('данные обновляются без перезагрузки страницы', async ({ page }) => {
    const polls: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/monitoring')) polls.push(request.url());
    });

    await page.goto('/monitoring');
    // Интервал опроса 4 с — ждём с запасом
    await page.waitForTimeout(5500);

    expect(polls.length).toBeGreaterThan(0);
  });

  test('ссылка на мониторинг есть в шапке', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Мониторинг' }).click();
    await expect(page).toHaveURL(/\/monitoring/);
  });
});
