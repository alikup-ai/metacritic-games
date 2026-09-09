import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbPool } from '../../src/shared/db/pool.js';
import { PostgresUnitOfWork } from '../../src/shared/db/unit-of-work.js';
import { PostgresGameRepository } from '../../src/modules/catalog/infrastructure/postgres-game-repository.js';
import {
  hashContent,
  PostgresReviewRepository,
  PostgresReviewSnapshotRepository,
} from '../../src/modules/reviews/infrastructure/postgres-review-repository.js';
import { PostgresReviewSummaryRepository } from '../../src/modules/analysis/infrastructure/postgres-summary-repository.js';
import { AnalyzeReviewsUseCase } from '../../src/modules/analysis/application/analyze-reviews.js';
import { FakeLlmProvider } from '../../src/modules/analysis/infrastructure/fake-llm-provider.js';
import { LlmError } from '../../src/modules/analysis/domain/llm-provider.js';
import type { ReviewSummary } from '../../src/modules/analysis/domain/summary.js';
import type { NormalizedReview, ReviewKind } from '../../src/modules/reviews/domain/review.js';
import { createTestPool, setupSchema, truncateAll } from './helpers.js';

/**
 * Интеграционные тесты резюме на РЕАЛЬНОЙ PostgreSQL.
 *
 * Модель подменяется заглушкой: реальный LLM API в обычном прогоне не
 * вызывается. Ограничения целостности и гонки — настоящие.
 */

let pool: DbPool;
let games: PostgresGameRepository;
let reviews: PostgresReviewRepository;
let snapshots: PostgresReviewSnapshotRepository;
let summaries: PostgresReviewSummaryRepository;
let unitOfWork: PostgresUnitOfWork;
let gameId: string;

function userReview(id: string, score = 8, quote = `Отзыв ${id} с текстом`): NormalizedReview {
  return {
    identity: { kind: 'user', externalId: id },
    platformSlug: 'pc',
    score,
    quote,
    author: 'author',
    reviewUrl: null,
    reviewDate: '2026-01-01',
    sourceVersion: 1,
    spoiler: false,
  };
}

function criticReview(slug: string, score = 85, platform = 'pc'): NormalizedReview {
  return {
    identity: { kind: 'critic', publicationSlug: slug },
    platformSlug: platform,
    score,
    quote: `Рецензия ${slug} с достаточным текстом`,
    author: slug.toUpperCase(),
    reviewUrl: `https://example.test/${slug}`,
    reviewDate: '2026-01-01',
    sourceVersion: null,
    spoiler: null,
  };
}

/** Кладёт отзывы напрямую, минуя синхронизацию: предмет теста — анализ. */
async function seedReviews(
  items: NormalizedReview[],
  kind: ReviewKind,
  platform = 'pc',
): Promise<void> {
  await unitOfWork.withTransaction(async (tx) => {
    await reviews.upsertMany({ gameId, kind, platformSlug: platform, reviews: items, tx });
  });
}

function makeUseCase(
  provider: FakeLlmProvider,
  overrides: Record<string, unknown> = {},
): AnalyzeReviewsUseCase {
  return new AnalyzeReviewsUseCase({
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
    retryCount: 1,
    maxOutputTokens: 1500,
    sleep: async () => undefined,
    ...overrides,
  });
}

const params = (kind: ReviewKind = 'user', platformSlug = 'pc') => ({
  gameId,
  gameTitle: 'Test Game',
  kind,
  platformSlug,
});

beforeAll(async () => {
  pool = createTestPool();
  await setupSchema(pool);
  games = new PostgresGameRepository(pool);
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
  const { game } = await games.upsert({
    source: 'metacritic',
    sourceSlug: 'test-game',
    parserVersion: 'v1',
    title: 'Test Game',
    developerStatus: 'unknown',
  });
  gameId = game.id;
});

describe('Сохранение резюме', () => {
  beforeEach(async () => {
    await seedReviews([userReview('u1', 9), userReview('u2', 2), userReview('u3', 6)], 'user');
  });

  it('резюме сохраняется со всеми полями', async () => {
    const useCase = makeUseCase(new FakeLlmProvider());
    const result = await useCase.execute(params());

    expect(result.status).toBe('ok');

    const saved = await summaries.find({ gameId, kind: 'user', platformSlug: 'pc' });
    expect(saved).not.toBeNull();
    expect(saved?.status).toBe('ok');
    expect(saved?.summary).toContain('Test Game');
    expect(saved?.inputHash).toHaveLength(64);
    expect(saved?.analyzedCount).toBe(3);
    expect(saved?.coverage).toBe('all_reviews');
    expect(saved?.model).toBe('fake-model-v1');
    expect(saved?.promptVersion).toBe('v1');
    expect(saved?.samplingVersion).toBe('v1');
  });

  it('структура выводов хранится в JSONB и читается обратно', async () => {
    const useCase = makeUseCase(new FakeLlmProvider());
    await useCase.execute(params());

    const saved = await summaries.find({ gameId, kind: 'user', platformSlug: 'pc' });

    expect(Array.isArray(saved?.liked)).toBe(true);
    expect(saved?.liked[0]?.evidenceRefs.length).toBeGreaterThan(0);
    expect(saved?.themes[0]?.sentiment).toBeTruthy();
  });

  it('текстовое представление выводится из структуры', async () => {
    const useCase = makeUseCase(new FakeLlmProvider());
    await useCase.execute(params());

    const { rows } = await pool.query<{ likes: string | null; dislikes: string | null }>(
      'SELECT likes, dislikes FROM review_summaries WHERE game_id = $1',
      [gameId],
    );

    expect(rows[0]?.likes).toBeTruthy();
    expect(rows[0]?.dislikes).toBeTruthy();
  });
});

describe('Идемпотентность на уровне БД', () => {
  beforeEach(async () => {
    await seedReviews([userReview('u1', 9), userReview('u2', 2), userReview('u3', 6)], 'user');
  });

  it('повторный анализ не создаёт второй строки', async () => {
    const provider = new FakeLlmProvider();
    const useCase = makeUseCase(provider);

    await useCase.execute(params());
    await useCase.execute(params());

    const { rows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM review_summaries WHERE game_id = $1',
      [gameId],
    );

    expect(Number(rows[0]?.count)).toBe(1);
    // Второй запуск вызова модели не делал
    expect(provider.requests).toHaveLength(1);
  });

  it('одновременный анализ одного входа не создаёт дубликата', async () => {
    // Уникальный ключ (game_id, kind, platform_slug) разрешает гонку
    const providers = [new FakeLlmProvider(), new FakeLlmProvider()];

    const results = await Promise.allSettled(
      providers.map((provider) => makeUseCase(provider).execute(params())),
    );

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM review_summaries WHERE game_id = $1',
      [gameId],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it('изменение отзыва даёт новый хеш и новый анализ', async () => {
    const provider = new FakeLlmProvider();

    await makeUseCase(provider).execute(params());
    const first = await summaries.find({ gameId, kind: 'user', platformSlug: 'pc' });

    // Тот же отзыв с изменённым текстом
    await seedReviews([userReview('u1', 9, 'СОВСЕМ ДРУГОЙ текст отзыва')], 'user');
    await makeUseCase(provider).execute(params());

    const second = await summaries.find({ gameId, kind: 'user', platformSlug: 'pc' });

    expect(second?.inputHash).not.toBe(first?.inputHash);
    expect(provider.requests).toHaveLength(2);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM review_summaries WHERE game_id = $1',
      [gameId],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it('смена версии промпта заставляет анализировать заново', async () => {
    const provider = new FakeLlmProvider();

    await makeUseCase(provider, { promptVersion: 'v1' }).execute(params());
    await makeUseCase(provider, { promptVersion: 'v2' }).execute(params());

    expect(provider.requests).toHaveLength(2);
    const saved = await summaries.find({ gameId, kind: 'user', platformSlug: 'pc' });
    expect(saved?.promptVersion).toBe('v2');
  });
});

describe('Целостность при сбоях', () => {
  beforeEach(async () => {
    await seedReviews([userReview('u1', 9), userReview('u2', 2), userReview('u3', 6)], 'user');
  });

  it('отзывы остаются в БД после сбоя анализа', async () => {
    const provider = new FakeLlmProvider({
      failWith: new LlmError('server_error', 'провайдер недоступен'),
    });

    const result = await makeUseCase(provider).execute(params());
    expect(result.status).toBe('failed');

    const count = await reviews.countByGame({ gameId, kind: 'user', platformSlug: 'pc' });
    expect(count).toBe(3);
  });

  it('запись о сбое не содержит хеша — повтор не блокируется', async () => {
    const provider = new FakeLlmProvider({
      failWith: new LlmError('client_error', 'отказ'),
    });
    await makeUseCase(provider).execute(params());

    const saved = await summaries.find({ gameId, kind: 'user', platformSlug: 'pc' });
    expect(saved?.status).toBe('failed');
    expect(saved?.inputHash).toBeNull();
    expect(saved?.errorCategory).toBe('client_error');

    // Ограничение БД разрешает отсутствие хеша только для неуспеха
    const ok = await makeUseCase(new FakeLlmProvider()).execute(params());
    expect(ok.status).toBe('ok');
  });

  it('успешное резюме без хеша БД не принимает', async () => {
    // Ограничение review_summaries_hash_required — защита от кеша-невидимки
    const broken: ReviewSummary = {
      gameId,
      kind: 'user',
      platformSlug: 'pc',
      status: 'ok',
      summary: 'Резюме без хеша',
      liked: [],
      disliked: [],
      themes: [],
      confidence: 'low',
      inputHash: null,
      sourceFingerprint: 'fp',
      model: 'm',
      promptVersion: 'v1',
      samplingVersion: 'v1',
      analyzedCount: 1,
      totalAvailable: 1,
      snapshotCompleteness: 'complete',
      coverage: 'all_reviews',
      tokensIn: null,
      tokensOut: null,
      lastError: null,
      errorCategory: null,
      generatedAt: new Date(),
    };

    await expect(summaries.save(broken)).rejects.toThrow();
  });

  it('откат транзакции не оставляет частичной записи', async () => {
    const failingUow = {
      withTransaction: async () => {
        throw new Error('сбой транзакции');
      },
    };

    const result = await makeUseCase(new FakeLlmProvider(), {
      unitOfWork: failingUow,
    }).execute(params());

    expect(result.status).toBe('failed');

    const { rows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM review_summaries WHERE game_id = $1',
      [gameId],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });
});

describe('Недостаточно отзывов', () => {
  it('статус фиксируется, модель не вызывается', async () => {
    await seedReviews([userReview('u1', 9)], 'user');

    const provider = new FakeLlmProvider();
    const result = await makeUseCase(provider).execute(params());

    expect(result.status).toBe('insufficient_reviews');
    expect(provider.requests).toHaveLength(0);

    const saved = await summaries.find({ gameId, kind: 'user', platformSlug: 'pc' });
    expect(saved?.status).toBe('insufficient_reviews');
  });
});

describe('Изоляция резюме', () => {
  it('критики и пользователи хранятся раздельно', async () => {
    await seedReviews([userReview('u1', 9), userReview('u2', 2), userReview('u3', 6)], 'user');
    await seedReviews(
      [criticReview('ign', 90), criticReview('gamespot', 40), criticReview('pcgamer', 75)],
      'critic',
    );

    const provider = new FakeLlmProvider();
    await makeUseCase(provider).execute(params('user'));
    await makeUseCase(provider).execute(params('critic'));

    const userSummary = await summaries.find({ gameId, kind: 'user', platformSlug: 'pc' });
    const criticSummary = await summaries.find({ gameId, kind: 'critic', platformSlug: 'pc' });

    expect(userSummary?.status).toBe('ok');
    expect(criticSummary?.status).toBe('ok');
    expect(userSummary?.inputHash).not.toBe(criticSummary?.inputHash);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM review_summaries WHERE game_id = $1',
      [gameId],
    );
    expect(Number(rows[0]?.count)).toBe(2);
  });

  it('разные платформы не перезаписывают друг друга', async () => {
    await seedReviews(
      [criticReview('ign', 90), criticReview('gamespot', 40), criticReview('pcgamer', 75)],
      'critic',
      'pc',
    );
    await seedReviews(
      [
        criticReview('ign', 88, 'playstation-5'),
        criticReview('gamespot', 60, 'playstation-5'),
        criticReview('edge', 70, 'playstation-5'),
      ],
      'critic',
      'playstation-5',
    );

    const provider = new FakeLlmProvider();
    await makeUseCase(provider).execute(params('critic', 'pc'));
    await makeUseCase(provider).execute(params('critic', 'playstation-5'));

    const pc = await summaries.find({ gameId, kind: 'critic', platformSlug: 'pc' });
    const ps5 = await summaries.find({ gameId, kind: 'critic', platformSlug: 'playstation-5' });

    expect(pc?.status).toBe('ok');
    expect(ps5?.status).toBe('ok');
    expect(pc?.inputHash).not.toBe(ps5?.inputHash);
  });

  it('резюме удаляется вместе с игрой', async () => {
    await seedReviews([userReview('u1', 9), userReview('u2', 2), userReview('u3', 6)], 'user');
    await makeUseCase(new FakeLlmProvider()).execute(params());

    await pool.query('DELETE FROM games WHERE id = $1', [gameId]);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM review_summaries WHERE game_id = $1',
      [gameId],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });
});
