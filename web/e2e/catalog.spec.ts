import { expect, test } from '@playwright/test';

/**
 * Основной пользовательский путь.
 *
 * Бэкенд подменён (e2e/mock-api.mjs): к Metacritic и OpenRouter обращений
 * нет. Проверяется поведение интерфейса.
 */

const WITCHER_ID = '11111111-1111-4111-8111-111111111111';
const CYBERPUNK_ID = '22222222-2222-4222-8222-222222222222';
const HOLLOW_ID = '33333333-3333-4333-8333-333333333333';

test.describe('Каталог', () => {
  test('открывается и показывает игры', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Каталог игр' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'The Witcher 3: Wild Hunt' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Cyberpunk 2077' })).toBeVisible();
  });

  test('ищет игру по названию', async ({ page }) => {
    await page.goto('/');

    await page.getByLabel('Поиск по названию').fill('witcher');
    await page.getByRole('button', { name: 'Найти' }).click();

    await expect(page.getByRole('heading', { name: 'The Witcher 3: Wild Hunt' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Cyberpunk 2077' })).toHaveCount(0);
    // Условие поиска сохраняется в адресе
    await expect(page).toHaveURL(/q=witcher/);
  });

  test('фильтрует по платформе', async ({ page }) => {
    await page.goto('/');

    // Смена значения запускает переход; ждём именно его, а не проверяем
    // адрес сразу — под нагрузкой переход ещё не успевает произойти
    await Promise.all([
      page.waitForURL(/platform=playstation-5/),
      page.getByLabel('Платформа').selectOption('playstation-5'),
    ]);
    await expect(page.getByRole('heading', { name: 'The Witcher 3: Wild Hunt' })).toBeVisible();
    // У Cyberpunk этой платформы нет
    await expect(page.getByRole('heading', { name: 'Cyberpunk 2077' })).toHaveCount(0);
  });

  test('отключённые платформы не предлагаются', async ({ page }) => {
    await page.goto('/');

    const options = await page.getByLabel('Платформа').locator('option').allTextContents();

    expect(options).toContain('PC');
    // Xbox One отключена на бэкенде и вариантом фильтра быть не должна
    expect(options.join(' ')).not.toContain('Xbox One');
  });

  test('сортирует по названию', async ({ page }) => {
    await page.goto('/');

    await page.getByLabel('Сортировка').selectOption('title');
    await expect(page).toHaveURL(/sort=title/);

    await page.getByLabel('Порядок').selectOption('asc');
    await expect(page).toHaveURL(/order=asc/);

    // Порядок проверяем после того, как список перерисован
    await expect(page.locator('.game-card__title').first()).toHaveText('Cyberpunk 2077');

    const titles = await page.locator('.game-card__title').allTextContents();
    expect(titles).toEqual([
      'Cyberpunk 2077',
      'Hollow Knight',
      'The Witcher 3: Wild Hunt',
    ]);
  });

  test('показывает отсутствие оценки прочерком, а не нулём', async ({ page }) => {
    await page.goto('/?q=hollow');

    const card = page.locator('.game-card').filter({ hasText: 'Hollow Knight' });
    await expect(card).toBeVisible();
    // Отсутствие оценки не должно выглядеть как ноль баллов
    await expect(card.locator('.score--none')).toHaveCount(2);
    await expect(card.locator('.score--none .score__value').first()).toHaveText('—');
  });

  test('не подставляет издателя вместо разработчика', async ({ page }) => {
    await page.goto('/?q=cyberpunk');

    const card = page.locator('.game-card').filter({ hasText: 'Cyberpunk 2077' });
    await expect(card).toContainText('Разработчик неизвестен');
    // Издатель у игры есть, но в поле разработчика попасть не должен
    await expect(card).not.toContainText('CD Projekt');
  });

  test('пустой результат поиска объясняется', async ({ page }) => {
    await page.goto('/?q=несуществующаяигра');

    await expect(page.getByRole('heading', { name: 'Ничего не найдено' })).toBeVisible();
  });

  test('переходит к карточке игры', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('link', { name: /The Witcher 3/ }).click();

    await expect(page).toHaveURL(new RegExp(WITCHER_ID));
    await expect(page.getByRole('heading', { name: 'The Witcher 3: Wild Hunt' })).toBeVisible();
  });
});

test.describe('Карточка игры', () => {
  test('показывает оценки и платформы', async ({ page }) => {
    await page.goto(`/games/${WITCHER_ID}`);

    await expect(page.getByRole('heading', { name: 'The Witcher 3: Wild Hunt' })).toBeVisible();
    await expect(page.locator('.score--high .score__value').first()).toHaveText('93');

    const table = page.locator('.platform-table');
    await expect(table).toContainText('PC');
    await expect(table).toContainText('PlayStation 5');
  });

  test('разделяет разработчика и издателя', async ({ page }) => {
    await page.goto(`/games/${WITCHER_ID}`);

    const list = page.locator('.definition-list');
    await expect(list).toContainText('Разработчик');
    await expect(list).toContainText('CD Projekt Red');
    await expect(list).toContainText('Издатель');
    await expect(list).toContainText('CD Projekt');
  });

  test('поясняет область действия общей оценки', async ({ page }) => {
    await page.goto(`/games/${WITCHER_ID}`);

    // Userscore общий по игре: это должно быть видно, а не выдано
    // за оценку конкретной платформы
    await expect(page.locator('.platform-table')).toContainText(
      'Оценка по игре в целом',
    );
  });

  test('помечает оценку, которую не удалось связать с платформой', async ({ page }) => {
    await page.goto(`/games/${CYBERPUNK_ID}`);

    await expect(page.locator('.platform-table')).toContainText(
      'Не удалось связать оценку с платформой',
    );
  });

  test('показывает ссылку на видео', async ({ page }) => {
    await page.goto(`/games/${WITCHER_ID}`);

    const link = page.getByRole('link', { name: 'Смотреть видео' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', 'https://example.test/witcher-trailer');
    await expect(link).toHaveAttribute('rel', /noopener/);
  });

  test('не показывает блок похожих игр', async ({ page }) => {
    await page.goto(`/games/${WITCHER_ID}`);

    // Расчёт не реализован; выдуманных рекомендаций быть не должно
    await expect(page.getByText(/похожие игры/i)).toHaveCount(0);
  });

  test('несуществующая игра даёт страницу «не найдено»', async ({ page }) => {
    await page.goto('/games/99999999-9999-4999-8999-999999999999');

    await expect(page.getByRole('heading', { name: 'Страница не найдена' })).toBeVisible();

    // Динамический маршрут начинает передаваться до проверки существования,
    // поэтому код ответа остаётся 200 (документированное поведение Next).
    // От индексации страницу защищает noindex, который Next добавляет сам.
    // Next вставляет тег и в head, и в поток разметки — берём первый
    const robots = page.locator('meta[name="robots"]').first();
    await expect(robots).toHaveAttribute('content', /noindex/);
  });

  test('некорректный идентификатор тоже даёт «не найдено»', async ({ page }) => {
    await page.goto('/games/not-a-uuid');
    await expect(page.getByRole('heading', { name: 'Страница не найдена' })).toBeVisible();
  });
});

test.describe('Разбор отзывов', () => {
  test('показывает мнения критиков и игроков раздельно', async ({ page }) => {
    await page.goto(`/games/${WITCHER_ID}`);

    const critics = page.locator('section').filter({ hasText: 'Мнение критиков' });
    const players = page.locator('section').filter({ hasText: 'Мнение игроков' });

    await expect(critics.first()).toBeVisible();
    await expect(players.first()).toBeVisible();

    // Тексты не смешиваются между аудиториями
    await expect(critics.first()).toContainText('Критики отмечают');
    await expect(players.first()).toContainText('Игроки хвалят');
  });

  test('раскрывает полноту анализа человекочитаемо', async ({ page }) => {
    await page.goto(`/games/${WITCHER_ID}`);

    // 200 из 6595 — доля обязана быть показана.
    // toLocaleString('ru-RU') разделяет разряды неразрывным пробелом,
    // поэтому сверяем по частям, а не буквальной строкой.
    const coverage = page.locator('.coverage').filter({ hasText: 'Проанализировано 200' });
    await expect(coverage).toBeVisible();
    await expect(coverage).toContainText('6');
    await expect(coverage).toContainText('595');
    await expect(coverage).toContainText('3,0%');
  });

  test('сообщает о полном охвате, когда он полный', async ({ page }) => {
    await page.goto(`/games/${WITCHER_ID}`);

    await expect(
      page.locator('.coverage').filter({ hasText: 'Проанализировано 33 из 33 отзывов' }),
    ).toBeVisible();
  });

  test('показывает неполный снимок', async ({ page }) => {
    await page.goto(`/games/${WITCHER_ID}`);

    await expect(
      page.getByText(/Получена только часть отзывов источника/),
    ).toBeVisible();
  });

  test('показывает прерванный сбор', async ({ page }) => {
    await page.goto(`/games/${CYBERPUNK_ID}`);

    await expect(page.getByText(/Сбор отзывов был прерван/)).toBeVisible();
  });

  test('предупреждает, что выводы по выборке', async ({ page }) => {
    await page.goto(`/games/${WITCHER_ID}`);

    await expect(
      page.getByText(/не отражают мнение всех авторов/),
    ).toBeVisible();
  });

  test('показывает уверенность отдельно от полноты', async ({ page }) => {
    await page.goto(`/games/${WITCHER_ID}`);

    await expect(page.getByText('Уверенность: высокая')).toBeVisible();
    await expect(page.getByText('Уверенность: средняя')).toBeVisible();
  });

  test('отсутствующий анализ критиков объясняется честно', async ({ page }) => {
    await page.goto(`/games/${CYBERPUNK_ID}`);

    const critics = page.locator('section').filter({ hasText: 'Мнение критиков' });
    await expect(critics.first()).toContainText('Анализ пока не выполнен');
    // Выдуманных выводов быть не должно
    await expect(critics.first()).not.toContainText('в основном положительные');
  });

  test('полное отсутствие анализа не ломает страницу', async ({ page }) => {
    await page.goto(`/games/${HOLLOW_ID}`);

    await expect(page.getByRole('heading', { name: 'Hollow Knight' })).toBeVisible();
    await expect(page.getByText('Анализ пока не выполнен')).toHaveCount(2);
  });

  test('ссылки на свидетельства сохраняются в данных', async ({ page }) => {
    await page.goto(`/games/${WITCHER_ID}`);

    // Пользователю как текст не показываются, но происхождение вывода
    // остаётся доступным
    const point = page.locator('[data-evidence-refs]').first();
    await expect(point).toHaveAttribute('data-evidence-refs', /r\d+/);
  });
});

test.describe('Безопасность', () => {
  test('разметка в описании не исполняется', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });

    await page.goto(`/games/${HOLLOW_ID}`);

    // Текст виден как текст
    await expect(page.getByText(/Метроидвания/)).toBeVisible();
    // Ни скриптов, ни внедрённых изображений
    expect(dialogs).toHaveLength(0);
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    await expect(page.locator('section script')).toHaveCount(0);
  });

  test('опасная схема ссылки отбрасывается', async ({ page }) => {
    await page.goto(`/games/${CYBERPUNK_ID}`);

    // videoUrl содержит javascript: — кнопки быть не должно
    await expect(page.getByRole('link', { name: 'Смотреть видео' })).toHaveCount(0);
    await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  });

  test('адрес бэкенда не попадает в браузер', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));

    await page.goto('/');

    // Браузер обращается только к своему origin
    expect(requests.every((url) => !url.includes('3101'))).toBe(true);
  });
});

test.describe('Сбои', () => {
  test('несуществующий путь даёт страницу «не найдено»', async ({ page }) => {
    const response = await page.goto('/no-such-page');

    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Страница не найдена' })).toBeVisible();
  });

  // Сценарий недоступного бэкенда проверяется отдельно (failure.spec.ts):
  // страницу рендерит сервер Next, и подмена заголовков в браузере на
  // его запросы не влияет.
});

test.describe('Доступность и адаптивность', () => {
  test('есть переход к содержимому и заголовки', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('.skip-link')).toHaveCount(1);
    await expect(page.locator('main#main')).toBeVisible();
    await expect(page.locator('h1')).toHaveCount(1);
  });

  test('навигация с клавиатуры доходит до поиска', async ({ page }) => {
    await page.goto('/');

    // Первый Tab — ссылка перехода к содержимому
    await page.keyboard.press('Tab');
    await expect(page.locator('.skip-link')).toBeFocused();
  });

  test('у полей есть подписи', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByLabel('Поиск по названию')).toBeVisible();
    await expect(page.getByLabel('Платформа')).toBeVisible();
    await expect(page.getByLabel('Сортировка')).toBeVisible();
  });

  test('страница не прокручивается по горизонтали', async ({ page }) => {
    await page.goto('/');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflow).toBe(false);
  });

  test('карточка игры помещается по ширине', async ({ page }) => {
    await page.goto(`/games/${WITCHER_ID}`);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflow).toBe(false);
  });
});
