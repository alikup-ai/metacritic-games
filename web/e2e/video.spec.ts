import { expect, test } from '@playwright/test';

/**
 * Раздел «Видео от блогеров».
 *
 * Бэкенд подменён: одна игра с полным разбором, вторая — с найденным
 * роликом без субтитров, третья — без обогащения вовсе.
 * Реальные YouTube и OpenRouter не вызываются.
 */

const WITH_ANALYSIS = '11111111-1111-4111-8111-111111111111';
const DEGRADED = '22222222-2222-4222-8222-222222222222';
const NO_ENRICHMENT = '33333333-3333-4333-8333-333333333333';

test.describe('Видеообзор', () => {
  test('показывает разбор видео', async ({ page }) => {
    await page.goto(`/games/${WITH_ANALYSIS}`);

    const section = page.locator('section').filter({ hasText: 'Видео от блогеров' });
    await expect(section.first()).toBeVisible();
    await expect(section.first()).toContainText('The Witcher 3 — полный обзор');
    await expect(section.first()).toContainText('GameChannel');
  });

  test('показывает просмотры и ссылку на YouTube', async ({ page }) => {
    await page.goto(`/games/${WITH_ANALYSIS}`);

    await expect(page.getByText(/1[\s\u00a0]234[\s\u00a0]567 просмотров/)).toBeVisible();

    const link = page.getByRole('link', { name: 'Смотреть на YouTube' });
    await expect(link).toHaveAttribute('href', 'https://www.youtube.com/watch?v=abc123');
    await expect(link).toHaveAttribute('rel', /noopener/);
  });

  test('показывает summary, понравилось, не понравилось и вывод', async ({ page }) => {
    await page.goto(`/games/${WITH_ANALYSIS}`);

    const section = page.locator('section').filter({ hasText: 'Видео от блогеров' }).first();
    await expect(section).toContainText('Автор хвалит проработанный мир');
    await expect(section).toContainText('Побочные задания');
    await expect(section).toContainText('Технические огрехи');
    await expect(section).toContainText('Игра остаётся эталоном жанра');
  });

  test('оговаривает, что это мнение одного автора', async ({ page }) => {
    await page.goto(`/games/${WITH_ANALYSIS}`);

    // Мнение блогера не должно выдаваться за оценку всех игроков
    await expect(
      page.getByText(/мнение одного автора видео, а не оценка всех игроков/),
    ).toBeVisible();
  });

  test('отсутствие субтитров объясняется, ссылка сохраняется', async ({ page }) => {
    await page.goto(`/games/${DEGRADED}`);

    const section = page.locator('section').filter({ hasText: 'Видео от блогеров' }).first();
    await expect(section).toContainText('нет субтитров');
    // Ролик всё равно полезен
    await expect(section.getByRole('link', { name: 'Смотреть на YouTube' })).toBeVisible();
    // Выдуманных выводов быть не должно
    await expect(section).not.toContainText('Вывод:');
  });

  test('без обогащения раздел не показывается', async ({ page }) => {
    await page.goto(`/games/${NO_ENRICHMENT}`);

    await expect(page.getByRole('heading', { name: 'Hollow Knight' })).toBeVisible();
    // Пустой раздел выглядел бы как поломка
    await expect(page.getByText('Видео от блогеров')).toHaveCount(0);
  });

  test('страница игры работает при недоступном обогащении', async ({ page }) => {
    await page.goto(`/games/${NO_ENRICHMENT}`);

    // Остальные разделы на месте
    await expect(page.getByRole('heading', { name: 'Платформы и оценки' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Разбор отзывов' })).toBeVisible();
  });

  test('ключи YouTube в браузер не попадают', async ({ page }) => {
    await page.goto(`/games/${WITH_ANALYSIS}`);

    const html = await page.content();
    expect(html).not.toContain('YOUTUBE_API_KEY');
    expect(html).not.toContain('googleapis.com');
  });
});
