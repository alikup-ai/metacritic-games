import { describe, expect, it } from 'vitest';
import { MetacriticAdapter } from '../../src/modules/ingestion/infrastructure/metacritic-adapter.js';
import { MetacriticHttpClient } from '../../src/modules/ingestion/infrastructure/metacritic-http-client.js';

/**
 * LIVE-ТЕСТ: обращается к реальному Metacritic.
 *
 * ТРЕБУЕТ СЕТЬ. В обычный прогон (`npm test`) и в CI НЕ входит:
 * каталог tests/live исключён из vitest.config.ts.
 *
 * Запуск: npm run test:metacritic-live
 *
 * Назначение — обнаружить расхождение между фикстурами и текущим состоянием
 * сайта. Падение этого теста при зелёных unit-тестах означает, что Metacritic
 * изменился и фикстуры устарели.
 *
 * Соблюдается вежливость: 1 запрос в секунду, честный User-Agent.
 */

// Только Latin-1: HTTP-заголовки не допускают кириллицу (ByteString).
const LIVE_USER_AGENT =
  'MetacriticGamesBot/0.1 (evaluation project; contact in repository)';

function makeLiveAdapter(): MetacriticAdapter {
  return new MetacriticAdapter({
    http: new MetacriticHttpClient({
      userAgent: LIVE_USER_AGENT,
      requestsPerSecond: 1,
      timeoutMs: 20_000,
      maxAttempts: 2,
    }),
  });
}

describe('LIVE: Metacritic доступен и разметка не изменилась', () => {
  it('раздел New Releases отдаёт карточки', async () => {
    const page = await makeLiveAdapter().fetchListing({ section: 'new_releases' });

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items[0]!.sourceSlug).toMatch(/^[a-z0-9-]+$/);
    expect(page.items[0]!.title.length).toBeGreaterThan(0);
  }, 60_000);

  it('листинг See All отдаёт карточки и поддерживает пагинацию', async () => {
    const adapter = makeLiveAdapter();

    const first = await adapter.fetchListing({ section: 'browse_all_new', page: 1 });
    const second = await adapter.fetchListing({ section: 'browse_all_new', page: 2 });

    expect(first.items.length).toBeGreaterThan(0);
    expect(second.items.length).toBeGreaterThan(0);
    expect(second.page).toBe(2);
  }, 60_000);

  it('карточка игры: developer как ссылка', async () => {
    const game = await makeLiveAdapter().fetchGame({ sourceSlug: 'elden-ring' });

    expect(game.title).toBe('Elden Ring');
    expect(game.developerStatus).toBe('resolved');
    expect(game.developer).toBe('From Software');
    // Издатель отдельно и не подменяет разработчика
    expect(game.publishers.length).toBeGreaterThan(0);
  }, 60_000);

  it('per-platform Metascore по-прежнему извлекается', async () => {
    const game = await makeLiveAdapter().fetchGame({ sourceSlug: 'elden-ring' });

    const scores = game.platforms
      .map((platform) => platform.metascore)
      .filter((score): score is number => score !== null);

    expect(game.platforms.length).toBeGreaterThanOrEqual(3);
    expect(scores.length).toBeGreaterThanOrEqual(2);
    // Различие значений — доказательство привязки к платформе (ADR-0008)
    expect(new Set(scores).size).toBeGreaterThan(1);

    for (const platform of game.platforms) {
      expect(platform.metascoreScope).toBe('platform');
      // Userscore по платформам не публикуется
      expect(platform.userscore).toBeNull();
      expect(platform.userscoreScope).toBe('overall');
    }
  }, 60_000);

  it('форма developer простым текстом по-прежнему встречается', async () => {
    const game = await makeLiveAdapter().fetchGame({
      sourceSlug: 'the-blood-of-dawnwalker',
    });

    expect(game.developerStatus).toBe('resolved');
    expect(game.developer).toBeTruthy();
  }, 60_000);
});
