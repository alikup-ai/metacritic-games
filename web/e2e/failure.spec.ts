import { expect, test } from '@playwright/test';

/**
 * Поведение при недоступном бэкенде.
 *
 * Страницы отрисовывает сервер Next, поэтому подмена ответов в браузере
 * на его запросы не влияет. Здесь приложение направляется на заведомо
 * закрытый порт: это и есть недоступность API.
 */

test.describe('Недоступный бэкенд', () => {
  test.use({ baseURL: 'http://127.0.0.1:3102' });

  test('каталог показывает сообщение вместо пустой страницы', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Данные недоступны' })).toBeVisible();
    // Выдуманных данных быть не должно
    await expect(page.locator('.game-card')).toHaveCount(0);
  });

  test('карточка игры сообщает о недоступности', async ({ page }) => {
    await page.goto('/games/11111111-1111-4111-8111-111111111111');

    await expect(page.getByRole('heading', { name: 'Данные недоступны' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Вернуться в каталог/ })).toBeVisible();
  });

  test('сообщение не раскрывает адрес бэкенда', async ({ page }) => {
    await page.goto('/');

    const text = await page.locator('main').innerText();
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain('3199');
    expect(text.toLowerCase()).not.toContain('econnrefused');
  });
});
