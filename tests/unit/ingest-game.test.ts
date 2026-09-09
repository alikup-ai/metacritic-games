import { describe, expect, it, vi } from 'vitest';
import {
  IngestGameUseCase,
  toGameUpsertInput,
  toPlatformInputs,
} from '../../src/modules/ingestion/application/ingest-game.js';
import { RecordingEventSink } from '../../src/modules/ingestion/domain/ingestion-events.js';
import { IngestionError } from '../../src/modules/ingestion/domain/ingestion-errors.js';
import type {
  GameCatalogSource,
  NormalizedGame,
} from '../../src/modules/ingestion/domain/catalog-source.js';
import type {
  GamePlatformRepository,
  GameRepository,
} from '../../src/modules/catalog/domain/game-repository.js';
import type { TxContext, UnitOfWork } from '../../src/modules/catalog/domain/unit-of-work.js';

/**
 * Unit-тесты application-слоя: без БД и без сети.
 *
 * Проверяют маппинг нормализованных данных в модель хранения и порядок
 * операций. Работа с реальной PostgreSQL покрыта интеграционными тестами.
 */

const FAKE_TX = {} as TxContext;

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
    description: 'Описание',
    videoUrl: 'https://cdn.example/trailer.m3u8',
    genres: ['Action RPG'],
    releaseDate: '2022-02-25',
    metascoreOverall: 96,
    userscoreOverall: null,
    userscoreStatus: 'disabled',
    platforms: [
      {
        platform: 'pc',
        platformName: 'PC',
        metascore: 94,
        metascoreScope: 'platform',
        userscore: null,
        userscoreScope: 'overall',
        criticCount: 63,
      },
    ],
    parserVersion: 'metacritic-detail-v1',
    ...overrides,
  };
}

describe('toGameUpsertInput — перенос без искажений', () => {
  it('developer и publishers остаются раздельными полями', () => {
    const input = toGameUpsertInput(
      normalizedGame({ developer: 'IllFonic', publishers: ['Gun Interactive'] }),
    );

    expect(input.developer).toBe('IllFonic');
    expect(input.publishers).toEqual(['Gun Interactive']);
  });

  it('пустой developer НЕ заменяется издателем', () => {
    const input = toGameUpsertInput(
      normalizedGame({
        developer: null,
        developerStatus: 'unknown',
        publishers: ['Some Publisher'],
      }),
    );

    expect(input.developer).toBeNull();
    expect(input.developerStatus).toBe('unknown');
    expect(input.developer).not.toBe('Some Publisher');
  });

  it('переносит основные поля', () => {
    const input = toGameUpsertInput(normalizedGame());

    expect(input.source).toBe('metacritic');
    expect(input.sourceSlug).toBe('elden-ring');
    expect(input.title).toBe('Elden Ring');
    expect(input.sourceUrl).toContain('/game/elden-ring/');
    expect(input.trailerUrl).toContain('trailer');
    expect(input.parserVersion).toBe('metacritic-detail-v1');
  });

  it('null-оценки остаются null, а не превращаются в 0', () => {
    const input = toGameUpsertInput(
      normalizedGame({ metascoreOverall: null, userscoreOverall: null }),
    );

    expect(input.metascoreOverall).toBeNull();
    expect(input.userscoreOverall).toBeNull();
  });
});

describe('toPlatformInputs — семантика оценок', () => {
  it('TBD сохраняется как null', () => {
    const [platform] = toPlatformInputs(
      normalizedGame({
        platforms: [
          {
            platform: 'xbox-one',
            platformName: 'Xbox One',
            metascore: null,
            metascoreScope: 'platform',
            userscore: null,
            userscoreScope: 'overall',
            criticCount: null,
          },
        ],
      }),
    );

    expect(platform!.metascore).toBeNull();
    expect(platform!.metascore).not.toBe(0);
  });

  it('userscore платформы не заполняется общим значением', () => {
    const inputs = toPlatformInputs(normalizedGame({ userscoreOverall: 8.4 }));

    for (const platform of inputs) {
      expect(platform.userscore).toBeNull();
      expect(platform.userscoreScope).toBe('overall');
    }
  });

  it('overall и overall_fallback переносятся как есть', () => {
    const inputs = toPlatformInputs(
      normalizedGame({
        platforms: [
          {
            platform: 'pc',
            platformName: 'PC',
            metascore: 94,
            metascoreScope: 'platform',
            userscore: null,
            userscoreScope: 'overall',
            criticCount: null,
          },
          {
            platform: 'switch',
            platformName: 'Switch',
            metascore: null,
            metascoreScope: 'overall_fallback',
            userscore: null,
            userscoreScope: 'overall',
            criticCount: null,
          },
        ],
      }),
    );

    expect(inputs[0]!.metascoreScope).toBe('platform');
    expect(inputs[1]!.metascoreScope).toBe('overall_fallback');
  });
});

describe('Порядок операций', () => {
  function makeDeps(game: NormalizedGame) {
    const order: string[] = [];

    const catalogSource: GameCatalogSource = {
      source: 'metacritic',
      fetchListing: vi.fn(),
      fetchGame: vi.fn(async () => {
        order.push('fetch');
        return game;
      }),
    };

    const games = {
      upsert: vi.fn(async () => {
        order.push('upsert');
        return {
          game: {
            id: 'game-1',
            title: game.title,
            developerStatus: game.developerStatus,
          },
          created: true,
        };
      }),
      findById: vi.fn(),
      findBySourceSlug: vi.fn(),
      list: vi.fn(),
    } as unknown as GameRepository;

    const platforms = {
      replacePlatformSnapshot: vi.fn(async () => {
        order.push('platforms');
        return {
          created: 1,
          updated: 0,
          deactivated: 0,
          reactivated: 0,
          skippedDeactivation: false,
        };
      }),
      findActiveByGameId: vi.fn(),
      findAllByGameId: vi.fn(),
      listDistinctPlatforms: vi.fn(),
    } as unknown as GamePlatformRepository;

    const unitOfWork: UnitOfWork = {
      withTransaction: vi.fn(async (work) => {
        order.push('begin');
        const result = await work(FAKE_TX);
        order.push('commit');
        return result;
      }),
    };

    return { catalogSource, games, platforms, unitOfWork, order };
  }

  it('сеть выполняется ДО начала транзакции', async () => {
    const deps = makeDeps(normalizedGame());
    const events = new RecordingEventSink();

    await new IngestGameUseCase({ ...deps, events }).execute({
      sourceSlug: 'elden-ring',
    });

    // HTTP не должен удерживать соединение с БД
    expect(deps.order).toEqual(['fetch', 'begin', 'upsert', 'platforms', 'commit']);
  });

  it('upsert и синхронизация платформ идут в ОДНОЙ транзакции', async () => {
    const deps = makeDeps(normalizedGame());

    await new IngestGameUseCase(deps).execute({ sourceSlug: 'elden-ring' });

    expect(deps.unitOfWork.withTransaction).toHaveBeenCalledTimes(1);

    const beginIndex = deps.order.indexOf('begin');
    const commitIndex = deps.order.indexOf('commit');
    expect(deps.order.indexOf('upsert')).toBeGreaterThan(beginIndex);
    expect(deps.order.indexOf('platforms')).toBeLessThan(commitIndex);
  });

  it('ошибка сети не открывает транзакцию', async () => {
    const deps = makeDeps(normalizedGame());
    deps.catalogSource.fetchGame = vi.fn(async () => {
      throw new IngestionError('network', 'Обрыв связи', {});
    });

    await expect(
      new IngestGameUseCase(deps).execute({ sourceSlug: 'elden-ring' }),
    ).rejects.toThrow();

    expect(deps.unitOfWork.withTransaction).not.toHaveBeenCalled();
  });

  it('обе операции получают ОДИН контекст транзакции', async () => {
    const deps = makeDeps(normalizedGame());

    await new IngestGameUseCase(deps).execute({ sourceSlug: 'elden-ring' });

    const upsertTx = vi.mocked(deps.games.upsert).mock.calls[0]![1];
    const platformTx = vi.mocked(deps.platforms.replacePlatformSnapshot).mock.calls[0]![2];

    expect(upsertTx).toBe(FAKE_TX);
    expect(platformTx).toBe(FAKE_TX);
  });
});

describe('События', () => {
  function minimalDeps(game: NormalizedGame) {
    return {
      catalogSource: {
        source: 'metacritic' as const,
        fetchListing: vi.fn(),
        fetchGame: vi.fn(async () => game),
      },
      games: {
        upsert: vi.fn(async () => ({
          game: { id: 'g1', title: game.title, developerStatus: game.developerStatus },
          created: true,
        })),
      } as unknown as GameRepository,
      platforms: {
        replacePlatformSnapshot: vi.fn(async () => ({
          created: 1,
          updated: 0,
          deactivated: 0,
          reactivated: 0,
          skippedDeactivation: false,
        })),
      } as unknown as GamePlatformRepository,
      unitOfWork: {
        withTransaction: vi.fn(async (work) => work(FAKE_TX)),
      } as UnitOfWork,
    };
  }

  it('userscore_fetched публикуется при наличии значения', async () => {
    const events = new RecordingEventSink();
    const deps = minimalDeps(normalizedGame({ userscoreOverall: 8.4 }));

    await new IngestGameUseCase({ ...deps, events }).execute({ sourceSlug: 'x' });

    expect(events.ofType('userscore_fetched')[0]!.userscore).toBe(8.4);
    expect(events.ofType('userscore_unavailable')).toHaveLength(0);
  });

  it('userscore_unavailable различает причины отсутствия', async () => {
    // Сбой запроса, отсутствие значения и выключенную догрузку нужно
    // различать: реакция на них разная.
    const cases = [
      { status: 'failed' as const, expected: 'failed' },
      { status: 'absent' as const, expected: 'absent' },
      { status: 'disabled' as const, expected: 'disabled' },
    ];

    for (const { status, expected } of cases) {
      const events = new RecordingEventSink();
      const deps = minimalDeps(
        normalizedGame({ userscoreOverall: null, userscoreStatus: status }),
      );

      await new IngestGameUseCase({ ...deps, events }).execute({ sourceSlug: 'x' });

      expect(events.ofType('userscore_unavailable')[0]!.reason).toBe(expected);
      expect(events.ofType('userscore_fetched')).toHaveLength(0);
    }
  });

  it('длительность измеряется по внешнему источнику времени', async () => {
    const events = new RecordingEventSink();
    const deps = minimalDeps(normalizedGame());
    let time = 1000;

    await new IngestGameUseCase({
      ...deps,
      events,
      now: () => {
        const current = time;
        time += 250;
        return current;
      },
    }).execute({ sourceSlug: 'x' });

    expect(events.ofType('ingestion_succeeded')[0]!.durationMs).toBeGreaterThan(0);
  });
});
