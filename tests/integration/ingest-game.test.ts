import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbPool } from '../../src/shared/db/pool.js';
import { PostgresUnitOfWork } from '../../src/shared/db/unit-of-work.js';
import { PostgresGameRepository } from '../../src/modules/catalog/infrastructure/postgres-game-repository.js';
import { PostgresGamePlatformRepository } from '../../src/modules/catalog/infrastructure/postgres-game-platform-repository.js';
import { IngestGameUseCase } from '../../src/modules/ingestion/application/ingest-game.js';
import { RecordingEventSink } from '../../src/modules/ingestion/domain/ingestion-events.js';
import { IngestionError } from '../../src/modules/ingestion/domain/ingestion-errors.js';
import type {
  FetchGameParams,
  FetchListingParams,
  GameCatalogSource,
  NormalizedGame,
  NormalizedListingPage,
  NormalizedPlatformScore,
} from '../../src/modules/ingestion/domain/catalog-source.js';
import { createTestPool, setupSchema, truncateAll } from './helpers.js';

/**
 * Интеграционные тесты ingestion на РЕАЛЬНОЙ PostgreSQL.
 *
 * Проверяются 10 сценариев идемпотентности и конкурентности из требований.
 * Источник каталога подменяется, БД — настоящая: race condition на
 * UNIQUE(source, source_slug) на моках не воспроизводится.
 */

let pool: DbPool;
let games: PostgresGameRepository;
let platforms: PostgresGamePlatformRepository;
let unitOfWork: PostgresUnitOfWork;

/** Источник каталога, отдающий заранее заданные данные. */
class StubCatalogSource implements GameCatalogSource {
  readonly source = 'metacritic' as const;
  fetchCount = 0;

  constructor(private supplier: (slug: string) => NormalizedGame | Error) {}

  setSupplier(supplier: (slug: string) => NormalizedGame | Error): void {
    this.supplier = supplier;
  }

  async fetchListing(_params: FetchListingParams): Promise<NormalizedListingPage> {
    throw new Error('не используется в этих тестах');
  }

  async fetchGame(params: FetchGameParams): Promise<NormalizedGame> {
    this.fetchCount += 1;
    const result = this.supplier(params.sourceSlug);
    if (result instanceof Error) throw result;
    return result;
  }
}

function platform(
  slug: string,
  name: string,
  metascore: number | null,
  overrides: Partial<NormalizedPlatformScore> = {},
): NormalizedPlatformScore {
  return {
    platform: slug,
    platformName: name,
    metascore,
    metascoreScope: 'platform',
    userscore: null,
    userscoreScope: 'overall',
    criticCount: null,
    ...overrides,
  };
}

function normalizedGame(overrides: Partial<NormalizedGame> = {}): NormalizedGame {
  return {
    source: 'metacritic',
    sourceSlug: 'elden-ring',
    title: 'Elden Ring',
    canonicalUrl: 'https://www.metacritic.com/game/elden-ring/',
    coverImageUrl: 'https://cdn.example/cover.jpg',
    developer: 'From Software',
    developerStatus: 'resolved',
    publishers: ['Bandai Namco Games'],
    description: 'Описание игры',
    videoUrl: null,
    genres: ['Action RPG'],
    releaseDate: '2022-02-25',
    metascoreOverall: 96,
    userscoreOverall: null,
    userscoreStatus: 'disabled',
    platforms: [platform('pc', 'PC', 94), platform('playstation-5', 'PlayStation 5', 96)],
    parserVersion: 'metacritic-detail-v1',
    ...overrides,
  };
}

function makeUseCase(
  source: StubCatalogSource,
  events = new RecordingEventSink(),
): { useCase: IngestGameUseCase; events: RecordingEventSink } {
  const useCase = new IngestGameUseCase({
    catalogSource: source,
    games,
    platforms,
    unitOfWork,
    events,
  });
  return { useCase, events };
}

async function countGames(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM games',
  );
  return Number(rows[0]?.count ?? 0);
}

async function countPlatformRows(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM game_platforms',
  );
  return Number(rows[0]?.count ?? 0);
}

beforeAll(async () => {
  pool = createTestPool();
  await setupSchema(pool);
  games = new PostgresGameRepository(pool);
  platforms = new PostgresGamePlatformRepository(pool);
  unitOfWork = new PostgresUnitOfWork(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
});

describe('Тест 1 — повторный ingestion одной игры', () => {
  it('даёт 1 Game и N GamePlatforms, а не 2 и 2N', async () => {
    const source = new StubCatalogSource(() => normalizedGame());
    const { useCase } = makeUseCase(source);

    const first = await useCase.execute({ sourceSlug: 'elden-ring' });
    const second = await useCase.execute({ sourceSlug: 'elden-ring' });

    expect(second.gameId).toBe(first.gameId);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    expect(await countGames()).toBe(1);
    expect(await countPlatformRows()).toBe(2);
  });

  it('троекратный ingestion не множит записи', async () => {
    const source = new StubCatalogSource(() => normalizedGame());
    const { useCase } = makeUseCase(source);

    await useCase.execute({ sourceSlug: 'elden-ring' });
    await useCase.execute({ sourceSlug: 'elden-ring' });
    await useCase.execute({ sourceSlug: 'elden-ring' });

    expect(await countGames()).toBe(1);
    expect(await countPlatformRows()).toBe(2);
  });

  it('title не используется как идентичность', async () => {
    const source = new StubCatalogSource((slug) =>
      normalizedGame({ sourceSlug: slug, title: 'DOOM' }),
    );
    const { useCase } = makeUseCase(source);

    await useCase.execute({ sourceSlug: 'doom-1993' });
    await useCase.execute({ sourceSlug: 'doom-2016' });

    // Одинаковое название, разные слаги — две разные игры
    expect(await countGames()).toBe(2);
  });
});

describe('Тест 2 — конкурентный ingestion ОДНОЙ игры', () => {
  it('создаётся ровно одна Game', async () => {
    const source = new StubCatalogSource(() => normalizedGame());
    const { useCase } = makeUseCase(source);

    const results = await Promise.all([
      useCase.execute({ sourceSlug: 'elden-ring' }),
      useCase.execute({ sourceSlug: 'elden-ring' }),
      useCase.execute({ sourceSlug: 'elden-ring' }),
    ]);

    // Race condition на UNIQUE(source, source_slug) разрешается СУБД
    expect(await countGames()).toBe(1);
    const ids = new Set(results.map((r) => r.gameId));
    expect(ids.size).toBe(1);
  });

  it('высокая конкуренция: 10 параллельных ingestion дают одну игру', async () => {
    const source = new StubCatalogSource(() => normalizedGame());
    const { useCase } = makeUseCase(source);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => useCase.execute({ sourceSlug: 'elden-ring' })),
    );

    // Ни одна транзакция не должна упасть по дедлоку или гонке
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(0);

    expect(await countGames()).toBe(1);
    expect(await countPlatformRows()).toBe(2);

    // Ровно один вызов создал игру, остальные обновили
    const created = results.filter(
      (r) => r.status === 'fulfilled' && r.value.created,
    );
    expect(created).toHaveLength(1);
  });

  it('платформы не дублируются при конкурентной записи', async () => {
    const source = new StubCatalogSource(() => normalizedGame());
    const { useCase } = makeUseCase(source);

    await Promise.all([
      useCase.execute({ sourceSlug: 'elden-ring' }),
      useCase.execute({ sourceSlug: 'elden-ring' }),
    ]);

    expect(await countPlatformRows()).toBe(2);
  });
});

describe('Тест 3 — конкурентный ingestion РАЗНЫХ игр', () => {
  it('обе игры сохраняются', async () => {
    const source = new StubCatalogSource((slug) =>
      normalizedGame({ sourceSlug: slug, title: `Игра ${slug}` }),
    );
    const { useCase } = makeUseCase(source);

    const [a, b] = await Promise.all([
      useCase.execute({ sourceSlug: 'game-a' }),
      useCase.execute({ sourceSlug: 'game-b' }),
    ]);

    expect(a.gameId).not.toBe(b.gameId);
    expect(await countGames()).toBe(2);
    expect(await countPlatformRows()).toBe(4);
  });

  it('пять игр параллельно сохраняются корректно', async () => {
    const source = new StubCatalogSource((slug) => normalizedGame({ sourceSlug: slug }));
    const { useCase } = makeUseCase(source);

    const slugs = ['g1', 'g2', 'g3', 'g4', 'g5'];
    await Promise.all(slugs.map((slug) => useCase.execute({ sourceSlug: slug })));

    expect(await countGames()).toBe(5);
  });
});

describe('Тест 4 — изменение оценки платформы', () => {
  it('в БД оказывается новое значение', async () => {
    const source = new StubCatalogSource(() =>
      normalizedGame({ platforms: [platform('pc', 'PC', 94)] }),
    );
    const { useCase } = makeUseCase(source);

    const first = await useCase.execute({ sourceSlug: 'elden-ring' });

    source.setSupplier(() => normalizedGame({ platforms: [platform('pc', 'PC', 97)] }));
    await useCase.execute({ sourceSlug: 'elden-ring' });

    const stored = await platforms.findActiveByGameId(first.gameId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.metascore).toBe(97);
  });

  it('оценка обновляется с tbd на числовую', async () => {
    const source = new StubCatalogSource(() =>
      normalizedGame({ platforms: [platform('pc', 'PC', null)] }),
    );
    const { useCase } = makeUseCase(source);

    const first = await useCase.execute({ sourceSlug: 'elden-ring' });
    let stored = await platforms.findActiveByGameId(first.gameId);
    expect(stored[0]!.metascore).toBeNull();

    source.setSupplier(() => normalizedGame({ platforms: [platform('pc', 'PC', 88)] }));
    await useCase.execute({ sourceSlug: 'elden-ring' });

    stored = await platforms.findActiveByGameId(first.gameId);
    expect(stored[0]!.metascore).toBe(88);
  });
});

describe('Тест 5 — появилась новая платформа', () => {
  it('создаётся только новая GamePlatform', async () => {
    const source = new StubCatalogSource(() =>
      normalizedGame({ platforms: [platform('pc', 'PC', 94)] }),
    );
    const { useCase, events } = makeUseCase(source);

    const first = await useCase.execute({ sourceSlug: 'elden-ring' });
    expect(first.platformsCreated).toBe(1);

    source.setSupplier(() =>
      normalizedGame({
        platforms: [platform('pc', 'PC', 94), platform('playstation-5', 'PlayStation 5', 96)],
      }),
    );
    const second = await useCase.execute({ sourceSlug: 'elden-ring' });

    // Создана одна новая, существующая обновлена
    expect(second.platformsCreated).toBe(1);
    expect(second.platformsUpdated).toBe(1);
    expect(second.platformsDeactivated).toBe(0);

    const stored = await platforms.findActiveByGameId(first.gameId);
    expect(stored).toHaveLength(2);

    const syncEvents = events.ofType('platforms_synchronized');
    expect(syncEvents.at(-1)!.created).toBe(1);
  });
});

describe('Тест 6 — платформа исчезла из источника (ADR-0011)', () => {
  it('отключается, но НЕ удаляется; данные сохраняются', async () => {
    const source = new StubCatalogSource(() =>
      normalizedGame({
        platforms: [platform('pc', 'PC', 94), platform('playstation-5', 'PlayStation 5', 96)],
      }),
    );
    const { useCase } = makeUseCase(source);

    const first = await useCase.execute({ sourceSlug: 'elden-ring' });

    source.setSupplier(() => normalizedGame({ platforms: [platform('pc', 'PC', 94)] }));
    const second = await useCase.execute({ sourceSlug: 'elden-ring' });

    expect(second.platformsDeactivated).toBe(1);

    // Активна только оставшаяся
    const active = await platforms.findActiveByGameId(first.gameId);
    expect(active).toHaveLength(1);
    expect(active[0]!.platformSlug).toBe('pc');

    // Но строка исчезнувшей платформы сохранена вместе с оценкой
    const all = await platforms.findAllByGameId(first.gameId);
    expect(all).toHaveLength(2);
    const ps5 = all.find((p) => p.platformSlug === 'playstation-5');
    expect(ps5!.isActive).toBe(false);
    expect(ps5!.metascore).toBe(96);
    expect(ps5!.deactivatedAt).not.toBeNull();
  });

  it('вернувшаяся платформа снова активируется', async () => {
    const source = new StubCatalogSource(() =>
      normalizedGame({
        platforms: [platform('pc', 'PC', 94), platform('playstation-5', 'PlayStation 5', 96)],
      }),
    );
    const { useCase } = makeUseCase(source);

    const first = await useCase.execute({ sourceSlug: 'elden-ring' });

    // Платформа пропала
    source.setSupplier(() => normalizedGame({ platforms: [platform('pc', 'PC', 94)] }));
    await useCase.execute({ sourceSlug: 'elden-ring' });

    // И вернулась
    source.setSupplier(() =>
      normalizedGame({
        platforms: [platform('pc', 'PC', 94), platform('playstation-5', 'PlayStation 5', 96)],
      }),
    );
    const third = await useCase.execute({ sourceSlug: 'elden-ring' });

    expect(third.platformsReactivated).toBe(1);

    const active = await platforms.findActiveByGameId(first.gameId);
    expect(active).toHaveLength(2);

    const all = await platforms.findAllByGameId(first.gameId);
    // Дубликат не создан — переиспользована та же строка
    expect(all).toHaveLength(2);
    expect(all.every((p) => p.deactivatedAt === null)).toBe(true);
  });

  it('ПУСТОЙ снимок не отключает платформы — защита от сбоя парсера', async () => {
    const source = new StubCatalogSource(() =>
      normalizedGame({ platforms: [platform('pc', 'PC', 94)] }),
    );
    const { useCase } = makeUseCase(source);

    const first = await useCase.execute({ sourceSlug: 'elden-ring' });

    // Парсер сломался и вернул пустой список платформ
    source.setSupplier(() => normalizedGame({ platforms: [] }));
    const second = await useCase.execute({ sourceSlug: 'elden-ring' });

    expect(second.platformsDeactivated).toBe(0);

    // Платформа осталась активной: пустой снимок = нет данных, а не «платформ нет»
    const active = await platforms.findActiveByGameId(first.gameId);
    expect(active).toHaveLength(1);
    expect(active[0]!.metascore).toBe(94);
  });
});

describe('Тест 7 — TBD не превращается в 0', () => {
  it('metascore = null сохраняется как NULL', async () => {
    const source = new StubCatalogSource(() =>
      normalizedGame({
        platforms: [platform('playstation-4', 'PlayStation 4', null)],
        metascoreOverall: null,
      }),
    );
    const { useCase } = makeUseCase(source);

    const result = await useCase.execute({ sourceSlug: 'elden-ring' });

    const stored = await platforms.findActiveByGameId(result.gameId);
    expect(stored[0]!.metascore).toBeNull();
    expect(stored[0]!.metascore).not.toBe(0);

    // Проверяем прямо в БД: значение именно NULL
    const { rows } = await pool.query<{ metascore: number | null }>(
      'SELECT metascore FROM game_platforms WHERE platform_slug = $1',
      ['playstation-4'],
    );
    expect(rows[0]!.metascore).toBeNull();

    const game = await games.findById(result.gameId);
    expect(game!.metascoreOverall).toBeNull();
  });

  it('platform_slug сохраняется даже без оценки', async () => {
    const source = new StubCatalogSource(() =>
      normalizedGame({ platforms: [platform('xbox-one', 'Xbox One', null)] }),
    );
    const { useCase } = makeUseCase(source);

    const result = await useCase.execute({ sourceSlug: 'elden-ring' });
    const stored = await platforms.findActiveByGameId(result.gameId);

    // Платформа известна, оценки нет — это валидное состояние
    expect(stored[0]!.platformSlug).toBe('xbox-one');
    expect(stored[0]!.metascoreScope).toBe('platform');
  });
});

describe('Тест 8 — отсутствующий developer', () => {
  it('publisher НЕ используется вместо developer', async () => {
    const source = new StubCatalogSource(() =>
      normalizedGame({
        developer: null,
        developerStatus: 'unknown',
        publishers: ['Big Publisher Ltd'],
      }),
    );
    const { useCase } = makeUseCase(source);

    const result = await useCase.execute({ sourceSlug: 'elden-ring' });
    const game = await games.findById(result.gameId);

    expect(game!.developer).toBeNull();
    expect(game!.developerStatus).toBe('unknown');
    expect(game!.publishers).toContain('Big Publisher Ltd');
    // Издатель не просочился в поле разработчика
    expect(game!.developer).not.toBe('Big Publisher Ltd');
  });

  it('unknown виден в событиях', async () => {
    const source = new StubCatalogSource(() =>
      normalizedGame({ developer: null, developerStatus: 'unknown' }),
    );
    const { useCase, events } = makeUseCase(source);

    await useCase.execute({ sourceSlug: 'elden-ring' });

    const created = events.ofType('game_created');
    expect(created[0]!.developerStatus).toBe('unknown');
  });

  it('изменение developer при повторном обходе обновляет запись', async () => {
    const source = new StubCatalogSource(() =>
      normalizedGame({ developer: null, developerStatus: 'unknown' }),
    );
    const { useCase } = makeUseCase(source);

    const first = await useCase.execute({ sourceSlug: 'elden-ring' });
    expect((await games.findById(first.gameId))!.developerStatus).toBe('unknown');

    // Источник начал отдавать разработчика
    source.setSupplier(() =>
      normalizedGame({ developer: 'From Software', developerStatus: 'resolved' }),
    );
    await useCase.execute({ sourceSlug: 'elden-ring' });

    const game = await games.findById(first.gameId);
    expect(game!.developer).toBe('From Software');
    expect(game!.developerStatus).toBe('resolved');
  });

  it('developer может стать неизвестным обратно', async () => {
    const source = new StubCatalogSource(() => normalizedGame());
    const { useCase } = makeUseCase(source);

    const first = await useCase.execute({ sourceSlug: 'elden-ring' });

    source.setSupplier(() =>
      normalizedGame({ developer: null, developerStatus: 'unknown' }),
    );
    await useCase.execute({ sourceSlug: 'elden-ring' });

    const game = await games.findById(first.gameId);
    expect(game!.developer).toBeNull();
    expect(game!.developerStatus).toBe('unknown');
  });
});

describe('Тест 9 — общий Userscore', () => {
  it('НЕ размножается по строкам платформ', async () => {
    const source = new StubCatalogSource(() =>
      normalizedGame({
        userscoreOverall: 8.4,
        platforms: [platform('pc', 'PC', 94), platform('playstation-5', 'PlayStation 5', 96)],
      }),
    );
    const { useCase } = makeUseCase(source);

    const result = await useCase.execute({ sourceSlug: 'elden-ring' });

    // Общий Userscore хранится на игре
    const game = await games.findById(result.gameId);
    expect(game!.userscoreOverall).toBe(8.4);

    // И НЕ разнесён по платформам
    const stored = await platforms.findActiveByGameId(result.gameId);
    for (const p of stored) {
      expect(p.userscore).toBeNull();
      expect(p.userscoreScope).toBe('overall');
    }
  });

  it('различает overall и overall_fallback', async () => {
    const source = new StubCatalogSource(() =>
      normalizedGame({
        platforms: [
          platform('pc', 'PC', 94, { metascoreScope: 'platform' }),
          platform('switch', 'Nintendo Switch', null, {
            metascoreScope: 'overall_fallback',
          }),
        ],
      }),
    );
    const { useCase } = makeUseCase(source);

    const result = await useCase.execute({ sourceSlug: 'elden-ring' });
    const stored = await platforms.findActiveByGameId(result.gameId);

    const pc = stored.find((p) => p.platformSlug === 'pc');
    const sw = stored.find((p) => p.platformSlug === 'switch');

    // Разные состояния сохранены раздельно и не смешаны
    expect(pc!.metascoreScope).toBe('platform');
    expect(sw!.metascoreScope).toBe('overall_fallback');
    expect(pc!.userscoreScope).toBe('overall');
  });

  it('неудача Userscore не затирает ранее сохранённое значение', async () => {
    const source = new StubCatalogSource(() => normalizedGame({ userscoreOverall: 8.4 }));
    const { useCase } = makeUseCase(source);

    const first = await useCase.execute({ sourceSlug: 'elden-ring' });
    expect((await games.findById(first.gameId))!.userscoreOverall).toBe(8.4);

    // Повторный обход без Userscore (запрос не удался или выключен)
    source.setSupplier(() => normalizedGame({ userscoreOverall: null }));
    await useCase.execute({ sourceSlug: 'elden-ring' });

    // Прежнее значение сохранилось, а не обнулилось
    const game = await games.findById(first.gameId);
    expect(game!.userscoreOverall).toBe(8.4);
  });

  it('события отражают наличие и отсутствие Userscore', async () => {
    const withScore = new StubCatalogSource(() =>
      normalizedGame({ userscoreOverall: 7.5, userscoreStatus: 'fetched' }),
    );
    const a = makeUseCase(withScore);
    await a.useCase.execute({ sourceSlug: 'g1' });
    expect(a.events.ofType('userscore_fetched')[0]!.userscore).toBe(7.5);

    const without = new StubCatalogSource(() =>
      normalizedGame({
        sourceSlug: 'g2',
        userscoreOverall: null,
        userscoreStatus: 'failed',
      }),
    );
    const b = makeUseCase(without);
    await b.useCase.execute({ sourceSlug: 'g2' });
    // Причина сохраняется: сбой запроса отличается от отсутствия значения
    expect(b.events.ofType('userscore_unavailable')[0]!.reason).toBe('failed');
  });
});

describe('Тест 10 — ошибка транзакции', () => {
  it('не оставляет частично сохранённых Game + Platforms', async () => {
    const source = new StubCatalogSource(() =>
      normalizedGame({
        // Недопустимая оценка: CHECK-ограничение отклонит вставку платформы
        platforms: [platform('pc', 'PC', 999)],
      }),
    );
    const { useCase } = makeUseCase(source);

    await expect(useCase.execute({ sourceSlug: 'elden-ring' })).rejects.toThrow();

    // Игра НЕ сохранена: транзакция откатилась целиком
    expect(await countGames()).toBe(0);
    expect(await countPlatformRows()).toBe(0);
  });

  it('ошибка на второй игре не портит первую', async () => {
    const source = new StubCatalogSource((slug) =>
      slug === 'bad'
        ? normalizedGame({ sourceSlug: 'bad', platforms: [platform('pc', 'PC', 999)] })
        : normalizedGame({ sourceSlug: slug }),
    );
    const { useCase } = makeUseCase(source);

    await useCase.execute({ sourceSlug: 'good' });
    await expect(useCase.execute({ sourceSlug: 'bad' })).rejects.toThrow();

    // Первая игра на месте, вторая не сохранена
    expect(await countGames()).toBe(1);
    const stored = await games.findBySourceSlug('metacritic', 'good');
    expect(stored).not.toBeNull();
  });

  it('откат при ошибке НЕ трогает уже существующую игру', async () => {
    const source = new StubCatalogSource(() =>
      normalizedGame({ platforms: [platform('pc', 'PC', 94)] }),
    );
    const { useCase } = makeUseCase(source);

    const first = await useCase.execute({ sourceSlug: 'elden-ring' });

    // Повторный обход падает на невалидных данных
    source.setSupplier(() =>
      normalizedGame({ title: 'Изменённое', platforms: [platform('pc', 'PC', 999)] }),
    );
    await expect(useCase.execute({ sourceSlug: 'elden-ring' })).rejects.toThrow();

    // Прежние данные не пострадали
    const game = await games.findById(first.gameId);
    expect(game!.title).toBe('Elden Ring');
    const stored = await platforms.findActiveByGameId(first.gameId);
    expect(stored[0]!.metascore).toBe(94);
  });

  it('ошибка сети не создаёт записей и помечает стадию fetch', async () => {
    const source = new StubCatalogSource(
      () => new IngestionError('network', 'Соединение потеряно', {}),
    );
    const { useCase, events } = makeUseCase(source);

    await expect(useCase.execute({ sourceSlug: 'elden-ring' })).rejects.toThrow();

    expect(await countGames()).toBe(0);
    const failed = events.ofType('ingestion_failed');
    expect(failed[0]!.stage).toBe('fetch');
    expect(failed[0]!.errorCategory).toBe('network');
  });
});

describe('События ingestion', () => {
  it('публикуется полная последовательность при успехе', async () => {
    const source = new StubCatalogSource(() => normalizedGame());
    const { useCase, events } = makeUseCase(source);

    await useCase.execute({ sourceSlug: 'elden-ring' });

    const types = events.events.map((e) => e.type);
    expect(types).toContain('ingestion_started');
    expect(types).toContain('game_created');
    expect(types).toContain('platforms_synchronized');
    expect(types).toContain('ingestion_succeeded');
    expect(types).not.toContain('ingestion_failed');
  });

  it('повторный обход публикует game_updated вместо game_created', async () => {
    const source = new StubCatalogSource(() => normalizedGame());
    const { useCase, events } = makeUseCase(source);

    await useCase.execute({ sourceSlug: 'elden-ring' });
    await useCase.execute({ sourceSlug: 'elden-ring' });

    expect(events.ofType('game_created')).toHaveLength(1);
    expect(events.ofType('game_updated')).toHaveLength(1);
  });

  it('slug нормализуется к нижнему регистру', async () => {
    const source = new StubCatalogSource(() => normalizedGame());
    const { useCase, events } = makeUseCase(source);

    await useCase.execute({ sourceSlug: '  Elden-Ring ' });

    expect(events.ofType('ingestion_started')[0]!.sourceSlug).toBe('elden-ring');
  });
});
