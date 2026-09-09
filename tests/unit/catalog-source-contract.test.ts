import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { MetacriticAdapter } from '../../src/modules/ingestion/infrastructure/metacritic-adapter.js';
import { MetacriticHttpClient } from '../../src/modules/ingestion/infrastructure/metacritic-http-client.js';
import { TokenBucketRateLimiter } from '../../src/shared/http/rate-limiter.js';
import { StructuredLogger, silentLogger } from '../../src/shared/logging/logger.js';
import type {
  GameCatalogSource,
  NormalizedGame,
  NormalizedListingPage,
} from '../../src/modules/ingestion/domain/catalog-source.js';

/**
 * Contract-тесты порта GameCatalogSource.
 *
 * Проверяют КОНТРАКТ, а не внутреннее устройство: какие поля обязаны
 * присутствовать, какие инварианты обязаны соблюдаться. Реализация может
 * сменить способ разбора HTML — тесты останутся валидными.
 *
 * Сеть не используется: HTTP подменяется отдачей фикстур.
 */

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'metacritic',
);

const load = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

/** Маршрутизирует запросы на фикстуры по пути URL. */
function makeAdapter(
  routes: Record<string, string>,
  options: { logger?: StructuredLogger; fetchUserscore?: boolean } = {},
): MetacriticAdapter {
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    const match = Object.entries(routes).find(([path]) => href.includes(path));
    if (!match) return new Response('not found', { status: 404 });
    return new Response(load(match[1]), {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  }) as unknown as typeof fetch;

  const http = new MetacriticHttpClient({
    userAgent: 'MetacriticGamesBot/0.1 (+https://example.test)',
    fetchImpl,
    sleep: async () => undefined,
    rateLimiter: new TokenBucketRateLimiter({
      requestsPerSecond: 1000,
      sleep: async () => undefined,
    }),
  });

  return new MetacriticAdapter({
    http,
    logger: options.logger ?? silentLogger,
    ...(options.fetchUserscore !== undefined
      ? { fetchUserscore: options.fetchUserscore }
      : {}),
  });
}

/** Проверки контракта, не зависящие от конкретного источника. */
function assertListingContract(page: NormalizedListingPage): void {
  expect(page.items.length).toBeGreaterThan(0);
  expect(page.skipped).toBeGreaterThanOrEqual(0);

  const slugs = new Set<string>();
  for (const item of page.items) {
    expect(item.source).toBe('metacritic');
    expect(item.sourceSlug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(item.title.trim().length).toBeGreaterThan(0);
    expect(item.canonicalUrl).toMatch(/^https:\/\/www\.metacritic\.com\/game\/[a-z0-9-]+\/$/);
    expect(item.position).toBeGreaterThanOrEqual(0);

    if (item.coverImageUrl !== null) {
      expect(item.coverImageUrl).toMatch(/^https:\/\//);
    }
    if (item.releaseDate !== null) {
      expect(item.releaseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }

    // Внутри страницы слаги уникальны
    expect(slugs.has(item.sourceSlug)).toBe(false);
    slugs.add(item.sourceSlug);
  }
}

function assertGameContract(game: NormalizedGame): void {
  expect(game.source).toBe('metacritic');
  expect(game.sourceSlug.length).toBeGreaterThan(0);
  expect(game.title.trim().length).toBeGreaterThan(0);
  expect(game.canonicalUrl).toMatch(/^https:\/\//);
  expect(game.parserVersion.length).toBeGreaterThan(0);

  // Инвариант ADR-0003: статус и значение согласованы
  if (game.developerStatus === 'resolved') {
    expect(game.developer).not.toBeNull();
    expect(game.developer!.trim().length).toBeGreaterThan(0);
  } else {
    expect(game.developer).toBeNull();
  }

  // Инвариант ADR-0003: издатель не подменяет разработчика
  if (game.developer !== null) {
    expect(game.publishers).not.toEqual([game.developer]);
  }

  for (const platform of game.platforms) {
    expect(platform.platform).toMatch(/^[a-z0-9-]+$/);
    expect(platform.platformName.length).toBeGreaterThan(0);
    expect(['platform', 'overall', 'overall_fallback', 'derived']).toContain(
      platform.metascoreScope,
    );

    if (platform.metascore !== null) {
      expect(platform.metascore).toBeGreaterThanOrEqual(0);
      expect(platform.metascore).toBeLessThanOrEqual(100);
    }

    // Инвариант ADR-0008: Userscore не приписывается платформе
    expect(platform.userscore).toBeNull();
    expect(platform.userscoreScope).toBe('overall');
  }

  if (game.metascoreOverall !== null) {
    expect(game.metascoreOverall).toBeGreaterThanOrEqual(0);
    expect(game.metascoreOverall).toBeLessThanOrEqual(100);
  }
  if (game.userscoreOverall !== null) {
    expect(game.userscoreOverall).toBeGreaterThanOrEqual(0);
    expect(game.userscoreOverall).toBeLessThanOrEqual(10);
  }
}

describe('GameCatalogSource — контракт листинга', () => {
  it('New Releases соответствует контракту', async () => {
    const adapter = makeAdapter({ '/game/': 'list-new-releases.html' });
    const page = await adapter.fetchListing({ section: 'new_releases' });

    expect(page.section).toBe('new_releases');
    assertListingContract(page);
  });

  it('Browse соответствует тому же контракту', async () => {
    const adapter = makeAdapter({ '/browse/': 'list-browse-page1.html' });
    const page = await adapter.fetchListing({ section: 'browse_all_new' });

    expect(page.section).toBe('browse_all_new');
    // Тот же набор проверок: разная разметка -> одинаковый контракт
    assertListingContract(page);
  });

  it('пагинация browse отражается в результате', async () => {
    const adapter = makeAdapter({ '/browse/': 'list-browse-page2.html' });
    const page = await adapter.fetchListing({ section: 'browse_all_new', page: 2 });

    expect(page.page).toBe(2);
    assertListingContract(page);
  });

  it('оба раздела возвращают структурно идентичный тип', async () => {
    const a = await makeAdapter({ '/game/': 'list-new-releases.html' }).fetchListing({
      section: 'new_releases',
    });
    const b = await makeAdapter({ '/browse/': 'list-browse-page1.html' }).fetchListing({
      section: 'browse_all_new',
    });

    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(Object.keys(a.items[0]!).sort()).toEqual(Object.keys(b.items[0]!).sort());
  });
});

describe('GameCatalogSource — контракт карточки игры', () => {
  it('игра с developer-ссылкой соответствует контракту', async () => {
    const adapter = makeAdapter({ '/game/elden-ring/': 'game-elden-ring.html' });
    const game = await adapter.fetchGame({ sourceSlug: 'elden-ring' });

    assertGameContract(game);
    expect(game.developer).toBe('From Software');
  });

  it('игра с developer-текстом соответствует контракту', async () => {
    const adapter = makeAdapter({
      '/game/the-blood-of-dawnwalker/': 'game-developer-plain-text.html',
    });
    const game = await adapter.fetchGame({ sourceSlug: 'the-blood-of-dawnwalker' });

    assertGameContract(game);
    expect(game.developer).toBe('Rebel Wolves');
  });

  it('игра без developer соответствует контракту', async () => {
    const adapter = makeAdapter({ '/game/fx/': 'game-developer-missing.html' });
    const game = await adapter.fetchGame({ sourceSlug: 'fx' });

    assertGameContract(game);
    expect(game.developerStatus).toBe('unknown');
  });

  it('multi-platform игра соответствует контракту', async () => {
    const adapter = makeAdapter({ '/game/w3/': 'game-witcher-3.html' });
    const game = await adapter.fetchGame({ sourceSlug: 'w3' });

    assertGameContract(game);
    expect(game.platforms.length).toBeGreaterThanOrEqual(3);
  });

  it('slug нормализуется к нижнему регистру', async () => {
    const adapter = makeAdapter({ '/game/elden-ring/': 'game-elden-ring.html' });
    const game = await adapter.fetchGame({ sourceSlug: '  Elden-Ring  ' });

    expect(game.sourceSlug).toBe('elden-ring');
  });

  it('пустой slug отклоняется', async () => {
    const adapter = makeAdapter({});
    await expect(adapter.fetchGame({ sourceSlug: '   ' })).rejects.toMatchObject({
      category: 'parse_error',
    });
  });
});

describe('Контракт: ошибки вместо пустых результатов', () => {
  it('нераспознанная структура листинга — ошибка', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html><body>redesign</body></html>', { status: 200 }),
    ) as unknown as typeof fetch;

    const adapter = new MetacriticAdapter({
      http: new MetacriticHttpClient({
        userAgent: 'test-agent',
        fetchImpl,
        sleep: async () => undefined,
        rateLimiter: new TokenBucketRateLimiter({
          requestsPerSecond: 1000,
          sleep: async () => undefined,
        }),
      }),
    });

    await expect(adapter.fetchListing({ section: 'new_releases' })).rejects.toMatchObject({
      category: 'parse_error',
    });
  });

  it('403 доходит до вызывающего как blocked', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('denied', { status: 403 }),
    ) as unknown as typeof fetch;

    const adapter = new MetacriticAdapter({
      http: new MetacriticHttpClient({
        userAgent: 'test-agent',
        fetchImpl,
        sleep: async () => undefined,
        rateLimiter: new TokenBucketRateLimiter({
          requestsPerSecond: 1000,
          sleep: async () => undefined,
        }),
      }),
    });

    await expect(adapter.fetchListing({ section: 'new_releases' })).rejects.toMatchObject({
      category: 'blocked',
    });
  });
});

describe('Наблюдаемость адаптера', () => {
  it('логирует операцию, количество элементов и длительность', async () => {
    const lines: string[] = [];
    const logger = new StructuredLogger({ sink: (line) => lines.push(line) });

    const adapter = makeAdapter({ '/game/': 'list-new-releases.html' }, { logger });
    await adapter.fetchListing({ section: 'new_releases' });

    const listingLog = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.operation === 'fetch_listing');

    expect(listingLog).toBeDefined();
    expect(listingLog!.source).toBe('metacritic');
    expect(listingLog!.parserResult).toBe('ok');
    expect(typeof listingLog!.parsedItems).toBe('number');
    expect(typeof listingLog!.durationMs).toBe('number');
  });

  it('отдельно сообщает о неопределённом разработчике', async () => {
    const lines: string[] = [];
    const logger = new StructuredLogger({ sink: (line) => lines.push(line) });

    const adapter = makeAdapter({ '/game/fx/': 'game-developer-missing.html' }, { logger });
    await adapter.fetchGame({ sourceSlug: 'fx' });

    const warning = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.developerStatus === 'unknown' && entry.level === 'warn');

    expect(warning).toBeDefined();
  });

  it('не логирует секреты', async () => {
    const lines: string[] = [];
    const logger = new StructuredLogger({ sink: (line) => lines.push(line) });

    const adapter = makeAdapter({ '/game/': 'list-new-releases.html' }, { logger });
    await adapter.fetchListing({ section: 'new_releases' });

    const joined = lines.join('\n').toLowerCase();
    expect(joined).not.toContain('authorization');
    expect(joined).not.toContain('cookie');
  });
});

describe('Порт реализуется адаптером', () => {
  it('MetacriticAdapter удовлетворяет типу GameCatalogSource', () => {
    const adapter = makeAdapter({});
    const source: GameCatalogSource = adapter;

    expect(source.source).toBe('metacritic');
    expect(typeof source.fetchListing).toBe('function');
    expect(typeof source.fetchGame).toBe('function');
  });
});
