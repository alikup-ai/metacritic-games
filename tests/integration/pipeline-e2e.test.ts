import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbPool } from '../../src/shared/db/pool.js';
import { PostgresUnitOfWork } from '../../src/shared/db/unit-of-work.js';
import { PostgresGameRepository } from '../../src/modules/catalog/infrastructure/postgres-game-repository.js';
import { PostgresGamePlatformRepository } from '../../src/modules/catalog/infrastructure/postgres-game-platform-repository.js';
import {
  hashContent,
  PostgresReviewRepository,
  PostgresReviewSnapshotRepository,
} from '../../src/modules/reviews/infrastructure/postgres-review-repository.js';
import { PostgresReviewSummaryRepository } from '../../src/modules/analysis/infrastructure/postgres-summary-repository.js';
import { IngestGameUseCase } from '../../src/modules/ingestion/application/ingest-game.js';
import { SyncReviewsUseCase } from '../../src/modules/reviews/application/sync-reviews.js';
import { AnalyzeReviewsUseCase } from '../../src/modules/analysis/application/analyze-reviews.js';
import { ProcessGamePipeline } from '../../src/modules/ingestion/application/process-game-pipeline.js';
import { FakeLlmProvider } from '../../src/modules/analysis/infrastructure/fake-llm-provider.js';
import { LlmError } from '../../src/modules/analysis/domain/llm-provider.js';
import { RecordingEventSink } from '../../src/modules/ingestion/domain/ingestion-events.js';
import { IngestionError } from '../../src/modules/ingestion/domain/ingestion-errors.js';
import type {
  GameCatalogSource,
  NormalizedGame,
} from '../../src/modules/ingestion/domain/catalog-source.js';
import type {
  NormalizedReview,
  NormalizedReviewPage,
} from '../../src/modules/reviews/domain/review.js';
import type {
  FetchReviewPageParams,
  ReviewSource,
} from '../../src/modules/reviews/domain/review-ports.js';
import { createTestPool, setupSchema, truncateAll } from './helpers.js';

/**
 * Сквозная проверка конвейера на РЕАЛЬНОЙ PostgreSQL.
 *
 * Внешние источники подменены: ни Metacritic, ни OpenRouter не
 * вызываются. Проверяется, что стадии связаны, а данные действительно
 * доходят до базы.
 */

let pool: DbPool;
let games: PostgresGameRepository;
let platforms: PostgresGamePlatformRepository;
let reviews: PostgresReviewRepository;
let snapshots: PostgresReviewSnapshotRepository;
let summaries: PostgresReviewSummaryRepository;
let unitOfWork: PostgresUnitOfWork;

const SLUG = 'test-game';

function makeGame(slug: string): NormalizedGame {
  return {
    source: 'metacritic',
    sourceSlug: slug,
    title: `Игра ${slug}`,
    canonicalUrl: `https://www.metacritic.com/game/${slug}/`,
    coverImageUrl: 'https://example.test/cover.jpg',
    developer: 'Test Studio',
    developerStatus: 'resolved',
    publishers: ['Test Publisher'],
    description: 'Описание',
    videoUrl: null,
    genres: ['Action'],
    releaseDate: '2026-01-01',
    metascoreOverall: 85,
    userscoreOverall: 8,
    userscoreStatus: 'fetched',
    platforms: [
      {
        platform: 'pc',
        platformName: 'PC',
        metascore: 85,
        metascoreScope: 'platform',
        userscore: null,
        userscoreScope: 'overall',
        criticCount: 10,
      },
    ],
    parserVersion: 'test-v1',
  };
}

/** Источник каталога, который можно заставить падать. */
class FakeCatalog implements GameCatalogSource {
  readonly source = 'metacritic' as const;
  failWith: Error | null = null;
  calls = 0;

  async fetchListing(): Promise<never> {
    // Конвейер листинг не запрашивает: игры уже отобраны заявками
    throw new Error('fetchListing не используется конвейером');
  }

  async fetchGame(params: { sourceSlug: string }): Promise<NormalizedGame> {
    this.calls += 1;
    if (this.failWith) throw this.failWith;
    return makeGame(params.sourceSlug);
  }
}

/** Источник отзывов с управляемым поведением. */
class FakeReviewSource implements ReviewSource {
  failWith: Error | null = null;
  criticReviews: NormalizedReview[] = [];
  userReviews: NormalizedReview[] = [];
  /** Объявленное источником количество; больше выданного = неполный снимок. */
  declaredTotal: number | null = null;

  async fetchReviewPage(params: FetchReviewPageParams): Promise<NormalizedReviewPage> {
    if (this.failWith) throw this.failWith;

    const items = params.kind === 'critic' ? this.criticReviews : this.userReviews;
    // Всё отдаётся первой страницей
    const page = params.offset === 0 ? items : [];

    return {
      kind: params.kind,
      platformSlug: params.platform ?? 'default',
      reviews: page,
      totalAvailable: this.declaredTotal ?? items.length,
      malformed: 0,
    };
  }
}

function userReview(id: string, score = 8, quote?: string): NormalizedReview {
  return {
    identity: { kind: 'user', externalId: id },
    platformSlug: 'default',
    score,
    quote: quote ?? `Отзыв ${id} с достаточным объёмом текста`,
    author: 'author',
    reviewUrl: null,
    reviewDate: '2026-01-01',
    sourceVersion: 1,
    spoiler: false,
  };
}

function criticReview(slug: string, score = 85): NormalizedReview {
  return {
    identity: { kind: 'critic', publicationSlug: slug },
    platformSlug: 'default',
    score,
    quote: `Рецензия ${slug} с достаточным объёмом текста`,
    author: slug.toUpperCase(),
    reviewUrl: `https://example.test/${slug}`,
    reviewDate: '2026-01-01',
    sourceVersion: null,
    spoiler: null,
  };
}

interface Harness {
  pipeline: ProcessGamePipeline;
  catalog: FakeCatalog;
  reviewSource: FakeReviewSource;
  provider: FakeLlmProvider;
  events: RecordingEventSink;
}

function makeHarness(
  options: { llmEnabled?: boolean; analysisFails?: LlmError } = {},
): Harness {
  const catalog = new FakeCatalog();
  const reviewSource = new FakeReviewSource();
  const provider = new FakeLlmProvider(
    options.analysisFails ? { failWith: options.analysisFails } : {},
  );
  const events = new RecordingEventSink();

  reviewSource.criticReviews = [
    criticReview('ign'),
    criticReview('gamespot', 70),
    criticReview('pcgamer', 90),
  ];
  reviewSource.userReviews = [
    userReview('u1', 9),
    userReview('u2', 3),
    userReview('u3', 7),
  ];

  const ingestGame = new IngestGameUseCase({
    catalogSource: catalog,
    games,
    platforms,
    unitOfWork,
  });

  const syncOptions = {
    source: reviewSource,
    reviews,
    snapshots,
    unitOfWork,
    hash: hashContent,
    maxPages: 5,
    pageSize: 50,
    maxReviews: 0,
  };

  const analyzeReviews =
    options.llmEnabled === false
      ? null
      : new AnalyzeReviewsUseCase({
          provider,
          reviews,
          snapshots,
          summaries,
          unitOfWork,
          hash: hashContent,
          limits: { maxReviews: 20, maxReviewChars: 500, maxInputChars: 50_000 },
          promptVersion: 'v1',
          samplingVersion: 'v1',
          minReviews: 3,
          retryCount: 0,
          maxOutputTokens: 1500,
          sleep: async () => undefined,
        });

  const pipeline = new ProcessGamePipeline({
    ingestGame,
    syncCriticReviews: new SyncReviewsUseCase(syncOptions),
    syncUserReviews: new SyncReviewsUseCase(syncOptions),
    analyzeReviews,
    events,
    now: () => new Date(),
    analysisPlatform: 'default',
  });

  return { pipeline, catalog, reviewSource, provider, events };
}

const params = { runId: 'run-1', sourceSlug: SLUG };

beforeAll(async () => {
  pool = createTestPool();
  await setupSchema(pool);
  games = new PostgresGameRepository(pool);
  platforms = new PostgresGamePlatformRepository(pool);
  reviews = new PostgresReviewRepository(pool);
  snapshots = new PostgresReviewSnapshotRepository(pool);
  summaries = new PostgresReviewSummaryRepository(pool);
  unitOfWork = new PostgresUnitOfWork(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
});

async function countRows(table: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table}`,
  );
  return Number(rows[0]?.count ?? 0);
}

// ============================================================================
// Сквозной успешный путь
// ============================================================================

describe('Сквозная обработка', () => {
  it('игра, отзывы и разбор доходят до базы', async () => {
    const { pipeline, provider } = makeHarness();

    const result = await pipeline.execute(params);

    expect(result.outcome).toBe('success');
    expect(result.gameId).toBeTruthy();

    // Игра сохранена
    expect(await countRows('games')).toBe(1);
    expect(await countRows('game_platforms')).toBe(1);

    // Отзывы обоих видов сохранены
    expect(await countRows('reviews')).toBe(6);

    // Снимки отзывов сохранены
    expect(await countRows('review_snapshots')).toBe(2);

    // Разбор выполнен для обоих видов
    expect(await countRows('review_summaries')).toBe(2);
    expect(provider.requests).toHaveLength(2);
  });

  it('резюме содержит поля полноты из наших данных', async () => {
    const { pipeline } = makeHarness();
    const result = await pipeline.execute(params);

    const summary = await summaries.find({
      gameId: result.gameId!,
      kind: 'user',
      platformSlug: 'default',
    });

    expect(summary?.status).toBe('ok');
    expect(summary?.analyzedCount).toBe(3);
    expect(summary?.coverage).toBe('all_reviews');
    expect(summary?.snapshotCompleteness).toBe('complete');
  });
});

// ============================================================================
// Изоляция стадий
// ============================================================================

describe('Изоляция стадий на реальных данных', () => {
  it('сбой получения игры не оставляет записей', async () => {
    const { pipeline, catalog } = makeHarness();
    catalog.failWith = new IngestionError('network', 'источник недоступен');

    const result = await pipeline.execute(params);

    expect(result.outcome).toBe('failed');
    expect(await countRows('games')).toBe(0);
    expect(await countRows('reviews')).toBe(0);
    expect(await countRows('review_summaries')).toBe(0);
  });

  it('сбой отзывов сохраняет игру, но не запускает разбор', async () => {
    const { pipeline, reviewSource, provider } = makeHarness();
    reviewSource.failWith = new IngestionError('network', 'источник отзывов недоступен');

    const result = await pipeline.execute(params);

    expect(result.outcome).toBe('failed');
    // Данные игры сохранены и пригодны к показу
    expect(await countRows('games')).toBe(1);
    expect(await countRows('reviews')).toBe(0);
    // Разбор по пустому набору не запускался
    expect(provider.requests).toHaveLength(0);
    expect(await countRows('review_summaries')).toBe(0);
  });

  it('сбой разбора сохраняет игру и отзывы', async () => {
    const { pipeline } = makeHarness({
      analysisFails: new LlmError('server_error', 'провайдер недоступен'),
    });

    const result = await pipeline.execute(params);

    // Игра и отзывы остаются нетронутыми: разбор — обогащающая стадия
    expect(await countRows('games')).toBe(1);
    expect(await countRows('reviews')).toBe(6);
    expect(result.gameId).toBeTruthy();
    expect(result.outcome).toBe('partial');
    expect(result.stageMap.summarize?.status).toBe('failed');
  });
});

// ============================================================================
// Разбор выключен
// ============================================================================

describe('Разбор выключен', () => {
  it('игра и отзывы обрабатываются, разбор пропускается', async () => {
    const { pipeline } = makeHarness({ llmEnabled: false });

    const result = await pipeline.execute(params);

    expect(await countRows('games')).toBe(1);
    expect(await countRows('reviews')).toBe(6);
    // Резюме не создаётся вовсе
    expect(await countRows('review_summaries')).toBe(0);

    expect(result.stageMap.summarize?.status).toBe('skipped');
    expect(result.stageMap.summarize?.reason).toBe('llm_disabled');
  });
});

// ============================================================================
// Идемпотентность
// ============================================================================

describe('Идемпотентность конвейера', () => {
  it('повторный запуск не создаёт дубликатов', async () => {
    const { pipeline } = makeHarness();

    await pipeline.execute(params);
    await pipeline.execute(params);

    expect(await countRows('games')).toBe(1);
    expect(await countRows('game_platforms')).toBe(1);
    expect(await countRows('reviews')).toBe(6);
    expect(await countRows('review_summaries')).toBe(2);
  });

  it('совпадение входного хеша не вызывает провайдера повторно', async () => {
    const { pipeline, provider } = makeHarness();

    await pipeline.execute(params);
    expect(provider.requests).toHaveLength(2);

    await pipeline.execute(params);
    // Второй проход: хеш совпал, обращения к модели нет
    expect(provider.requests).toHaveLength(2);
  });

  it('изменение отзыва приводит к новому разбору', async () => {
    const { pipeline, reviewSource, provider } = makeHarness();

    await pipeline.execute(params);
    expect(provider.requests).toHaveLength(2);

    // Меняем ОЦЕНКУ: отпечаток снимка считается по ключу и оценке
    // (DR-4), поэтому изменение только текста стадия синхронизации
    // намеренно не заметит — это оптимизация, а не дефект.
    reviewSource.userReviews = [
      userReview('u1', 2),
      userReview('u2', 3),
      userReview('u3', 7),
    ];

    await pipeline.execute(params);

    // Набор изменился → новый входной хеш → разбор выполнен заново
    expect(provider.requests.length).toBeGreaterThan(2);
  });
});

// ============================================================================
// Неполный снимок
// ============================================================================

describe('Неполный снимок отзывов', () => {
  it('помечается и понижает исход', async () => {
    const { pipeline, reviewSource } = makeHarness();

    // Источник объявляет больше отзывов, чем отдал
    reviewSource.declaredTotal = 100;

    const result = await pipeline.execute(params);

    expect(result.outcome).toBe('partial');
    expect(result.stageMap.fetchReviews?.reason).toBe('incomplete_reviews');
  });
});
