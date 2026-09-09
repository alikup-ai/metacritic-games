import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbPool } from '../../src/shared/db/pool.js';
import { PostgresUnitOfWork } from '../../src/shared/db/unit-of-work.js';
import { PostgresGameRepository } from '../../src/modules/catalog/infrastructure/postgres-game-repository.js';
import { PostgresGamePlatformRepository } from '../../src/modules/catalog/infrastructure/postgres-game-platform-repository.js';
import { PostgresReviewRepository } from '../../src/modules/reviews/infrastructure/postgres-review-repository.js';
import { PostgresReviewSummaryRepository } from '../../src/modules/analysis/infrastructure/postgres-summary-repository.js';
import { FindSimilarGamesUseCase } from '../../src/modules/similarity/application/find-similar-games.js';
import { PostgresVideoInsightRepository } from '../../src/modules/video/infrastructure/postgres-video-repository.js';
import { Router } from '../../src/api/server.js';
import {
  createGetAnalysisHandler,
  createGetGameHandler,
  createListGamesHandler,
  createListPlatformsHandler,
  createListReviewsHandler,
  type CatalogDeps,
} from '../../src/api/routes/catalog-routes.js';
import type { NormalizedReview, ReviewKind } from '../../src/modules/reviews/domain/review.js';
import type { ReviewSummary } from '../../src/modules/analysis/domain/summary.js';
import { createTestPool, setupSchema, truncateAll } from './helpers.js';
import { startTestServer, type TestServer } from './api-helpers.js';

/**
 * Тесты API каталога на РЕАЛЬНОЙ PostgreSQL через настоящий HTTP.
 * Внешние сервисы не вызываются.
 */

let pool: DbPool;
let games: PostgresGameRepository;
let platforms: PostgresGamePlatformRepository;
let reviews: PostgresReviewRepository;
let summaries: PostgresReviewSummaryRepository;
let unitOfWork: PostgresUnitOfWork;
let server: TestServer;

interface SeededGame {
  id: string;
  slug: string;
}

async function seedGame(params: {
  slug: string;
  title: string;
  metascore?: number | null;
  userscore?: number | null;
  releaseDate?: string | null;
  developer?: string | null;
  publishers?: readonly string[];
  platforms?: { slug: string; name: string; metascore: number | null }[];
  inactivePlatform?: { slug: string; name: string };
}): Promise<SeededGame> {
  const { game } = await games.upsert({
    source: 'metacritic',
    sourceSlug: params.slug,
    parserVersion: 'v1',
    title: params.title,
    description: `Описание ${params.title}`,
    coverUrl: `https://example.test/${params.slug}.jpg`,
    trailerUrl: `https://example.test/${params.slug}.mp4`,
    // Различаем «не указан» (undefined -> значение по умолчанию) и
    // «разработчика нет» (явный null): ?? схлопнул бы их в одно.
    developer: params.developer === undefined ? 'Test Studio' : params.developer,
    developerStatus: params.developer === null ? 'unknown' : 'resolved',
    publishers: params.publishers ?? ['Test Publisher'],
    genres: ['Action'],
    releaseDate: params.releaseDate ?? '2026-01-01',
    metascoreOverall: params.metascore ?? null,
    userscoreOverall: params.userscore ?? null,
  });

  const snapshot = (params.platforms ?? [{ slug: 'pc', name: 'PC', metascore: 80 }]).map(
    (p) => ({
      platformSlug: p.slug,
      platformName: p.name,
      metascore: p.metascore,
      metascoreScope: 'platform' as const,
      userscore: null,
      userscoreScope: 'overall' as const,
      criticCount: 10,
      userCount: null,
    }),
  );

  if (params.inactivePlatform) {
    // Сначала платформа существует, затем исчезает из снимка -> отключается
    await platforms.replacePlatformSnapshot(game.id, [
      ...snapshot,
      {
        platformSlug: params.inactivePlatform.slug,
        platformName: params.inactivePlatform.name,
        metascore: 70,
        metascoreScope: 'platform' as const,
        userscore: null,
        userscoreScope: 'overall' as const,
        criticCount: 3,
        userCount: null,
      },
    ]);
  }

  await platforms.replacePlatformSnapshot(game.id, snapshot);
  return { id: game.id, slug: params.slug };
}

async function seedReviews(
  gameId: string,
  kind: ReviewKind,
  items: NormalizedReview[],
  platform = 'pc',
): Promise<void> {
  await unitOfWork.withTransaction(async (tx) => {
    await reviews.upsertMany({ gameId, kind, platformSlug: platform, reviews: items, tx });
  });
}

function userReview(id: string, score = 8): NormalizedReview {
  return {
    identity: { kind: 'user', externalId: id },
    platformSlug: 'pc',
    score,
    quote: `Отзыв ${id}`,
    author: 'author',
    reviewUrl: null,
    reviewDate: '2026-01-01',
    sourceVersion: 1,
    spoiler: false,
  };
}

function criticReview(slug: string, platform = 'pc'): NormalizedReview {
  return {
    identity: { kind: 'critic', publicationSlug: slug },
    platformSlug: platform,
    score: 85,
    quote: `Рецензия ${slug}`,
    author: slug.toUpperCase(),
    reviewUrl: `https://example.test/${slug}`,
    reviewDate: '2026-01-01',
    sourceVersion: null,
    spoiler: null,
  };
}

function summaryOf(overrides: Partial<ReviewSummary> & { gameId: string }): ReviewSummary {
  return {
    kind: 'user',
    platformSlug: 'pc',
    status: 'ok',
    summary: 'Резюме анализа',
    liked: [{ text: 'Хорошо', evidenceRefs: ['r1'] }],
    disliked: [{ text: 'Плохо', evidenceRefs: ['r2'] }],
    themes: [
      {
        name: 'тема',
        sentiment: 'mixed',
        description: 'описание',
        evidenceRefs: ['r1'],
      },
    ],
    confidence: 'medium',
    inputHash: 'a'.repeat(64),
    sourceFingerprint: 'fp',
    model: 'test/model',
    promptVersion: 'v1',
    samplingVersion: 'v1',
    analyzedCount: 12,
    totalAvailable: 40,
    snapshotCompleteness: 'complete',
    coverage: 'sample',
    tokensIn: 100,
    tokensOut: 50,
    lastError: null,
    errorCategory: null,
    generatedAt: new Date('2026-02-01T00:00:00Z'),
    ...overrides,
  };
}

beforeAll(async () => {
  pool = createTestPool();
  await setupSchema(pool);
  games = new PostgresGameRepository(pool);
  platforms = new PostgresGamePlatformRepository(pool);
  reviews = new PostgresReviewRepository(pool);
  summaries = new PostgresReviewSummaryRepository(pool);
  unitOfWork = new PostgresUnitOfWork(pool);

  const deps: CatalogDeps = {
    games,
    platforms,
    reviews,
    summaries,
    similar: new FindSimilarGamesUseCase({ games, candidateLimit: 500 }),
    videoInsights: new PostgresVideoInsightRepository(pool),
    enrichVideo: null,
    pageDefaults: { defaultSize: 20, maxSize: 100 },
  };

  const router = new Router()
    .get('/api/games', createListGamesHandler(deps))
    .get('/api/games/:id', createGetGameHandler(deps))
    .get('/api/games/:id/analysis', createGetAnalysisHandler(deps))
    .get('/api/games/:id/reviews', createListReviewsHandler(deps))
    .get('/api/platforms', createListPlatformsHandler(deps));

  server = await startTestServer(router);
});

afterAll(async () => {
  await server.close();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
});

// ============================================================================
// GET /api/games
// ============================================================================

describe('GET /api/games', () => {
  it('возвращает список с пагинацией', async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedGame({ slug: `g-${i}`, title: `Игра ${i}`, metascore: 70 + i });
    }

    const { status, body } = await server.request('/api/games');
    const payload = body as { items: unknown[]; pagination: Record<string, number> };

    expect(status).toBe(200);
    expect(payload.items).toHaveLength(5);
    expect(payload.pagination).toEqual({
      page: 1,
      pageSize: 20,
      total: 5,
      totalPages: 1,
    });
  });

  it('пустой каталог даёт одну пустую страницу', async () => {
    const { body } = await server.request('/api/games');
    const payload = body as { items: unknown[]; pagination: { totalPages: number } };

    expect(payload.items).toHaveLength(0);
    // Ноль страниц сделал бы page=1 недопустимым
    expect(payload.pagination.totalPages).toBe(1);
  });

  it('делит результат на страницы', async () => {
    for (let i = 0; i < 7; i += 1) {
      await seedGame({ slug: `g-${i}`, title: `Игра ${i}`, metascore: 90 - i });
    }

    const first = await server.request('/api/games?page=1&pageSize=3');
    const second = await server.request('/api/games?page=2&pageSize=3');

    const p1 = first.body as { items: { id: string }[]; pagination: { totalPages: number } };
    const p2 = second.body as { items: { id: string }[] };

    expect(p1.items).toHaveLength(3);
    expect(p2.items).toHaveLength(3);
    expect(p1.pagination.totalPages).toBe(3);

    // Страницы не пересекаются
    const ids1 = p1.items.map((i) => i.id);
    const ids2 = p2.items.map((i) => i.id);
    expect(ids1.filter((id) => ids2.includes(id))).toHaveLength(0);
  });

  it('ищет по названию', async () => {
    await seedGame({ slug: 'witcher', title: 'The Witcher 3' });
    await seedGame({ slug: 'cyber', title: 'Cyberpunk 2077' });

    const { body } = await server.request('/api/games?q=witcher');
    const payload = body as { items: { title: string }[] };

    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]!.title).toBe('The Witcher 3');
  });

  it('фильтрует по платформе', async () => {
    await seedGame({
      slug: 'pc-only',
      title: 'PC Only',
      platforms: [{ slug: 'pc', name: 'PC', metascore: 80 }],
    });
    await seedGame({
      slug: 'ps5-only',
      title: 'PS5 Only',
      platforms: [{ slug: 'playstation-5', name: 'PlayStation 5', metascore: 85 }],
    });

    const { body } = await server.request('/api/games?platform=playstation-5');
    const payload = body as { items: { title: string }[] };

    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]!.title).toBe('PS5 Only');
  });

  it('отключённая платформа не участвует в фильтре', async () => {
    await seedGame({
      slug: 'was-xbox',
      title: 'Was On Xbox',
      platforms: [{ slug: 'pc', name: 'PC', metascore: 80 }],
      inactivePlatform: { slug: 'xbox-one', name: 'Xbox One' },
    });

    const { body } = await server.request('/api/games?platform=xbox-one');
    const payload = body as { items: unknown[] };

    // Данные сохранены, но как активный фильтр платформа не работает
    expect(payload.items).toHaveLength(0);
  });

  it('сортирует по метаоценке по убыванию', async () => {
    await seedGame({ slug: 'low', title: 'Low', metascore: 60 });
    await seedGame({ slug: 'high', title: 'High', metascore: 95 });
    await seedGame({ slug: 'mid', title: 'Mid', metascore: 78 });

    const { body } = await server.request('/api/games?sort=metascore&order=desc');
    const payload = body as { items: { metascore: number }[] };

    expect(payload.items.map((i) => i.metascore)).toEqual([95, 78, 60]);
  });

  it('сортирует по названию по возрастанию', async () => {
    await seedGame({ slug: 'c', title: 'Charlie' });
    await seedGame({ slug: 'a', title: 'Alpha' });
    await seedGame({ slug: 'b', title: 'Bravo' });

    const { body } = await server.request('/api/games?sort=title&order=asc');
    const payload = body as { items: { title: string }[] };

    expect(payload.items.map((i) => i.title)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('сортирует по дате выхода', async () => {
    await seedGame({ slug: 'old', title: 'Old', releaseDate: '2020-01-01' });
    await seedGame({ slug: 'new', title: 'New', releaseDate: '2026-01-01' });

    const { body } = await server.request('/api/games?sort=releaseDate&order=desc');
    const payload = body as { items: { title: string }[] };

    expect(payload.items[0]!.title).toBe('New');
  });

  it('отклоняет недопустимое поле сортировки', async () => {
    const { status, body } = await server.request('/api/games?sort=id');
    const payload = body as { error: { code: string; details?: { allowed: string[] } } };

    expect(status).toBe(400);
    expect(payload.error.code).toBe('VALIDATION_ERROR');
    expect(payload.error.details?.allowed).toContain('metascore');
  });

  it('отклоняет недопустимое направление сортировки', async () => {
    const { status, body } = await server.request('/api/games?order=random');
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('отклоняет некорректный номер страницы', async () => {
    for (const value of ['0', '-1', 'abc', '1.5']) {
      const { status } = await server.request(`/api/games?page=${value}`);
      expect(status).toBe(400);
    }
  });

  it('отклоняет чрезмерный pageSize', async () => {
    const { status, body } = await server.request('/api/games?pageSize=100000');
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('не отдаёт доменные поля наружу', async () => {
    await seedGame({ slug: 'g1', title: 'Игра' });

    const { body } = await server.request('/api/games');
    const item = (body as { items: Record<string, unknown>[] }).items[0]!;

    // Внутренние поля источника наружу не идут
    expect(item).not.toHaveProperty('contentHash');
    expect(item).not.toHaveProperty('parserVersion');
    expect(item).not.toHaveProperty('sourceSlug');
  });
});

// ============================================================================
// GET /api/games/:id
// ============================================================================

describe('GET /api/games/:id', () => {
  it('возвращает полную карточку', async () => {
    const game = await seedGame({
      slug: 'full',
      title: 'Полная игра',
      metascore: 88,
      userscore: 7,
      publishers: ['Publisher A', 'Publisher B'],
    });

    const { status, body } = await server.request(`/api/games/${game.id}`);
    const dto = body as Record<string, unknown>;

    expect(status).toBe(200);
    expect(dto.id).toBe(game.id);
    expect(dto.title).toBe('Полная игра');
    expect(dto.coverUrl).toBe('https://example.test/full.jpg');
    expect(dto.videoUrl).toBe('https://example.test/full.mp4');
    expect(dto.description).toBe('Описание Полная игра');
    expect(dto.releaseDate).toBe('2026-01-01');
    expect(dto.metascore).toBe(88);
    expect(dto.userscore).toBe(7);
  });

  it('разработчик и издатель разделены', async () => {
    const game = await seedGame({
      slug: 'sep',
      title: 'Игра',
      developer: 'Real Studio',
      publishers: ['Some Publisher'],
    });

    const { body } = await server.request(`/api/games/${game.id}`);
    const dto = body as { developer: string; publishers: string[]; developerStatus: string };

    expect(dto.developer).toBe('Real Studio');
    expect(dto.publishers).toEqual(['Some Publisher']);
    expect(dto.developerStatus).toBe('resolved');
  });

  it('отсутствующий разработчик даёт null, а не издателя', async () => {
    const game = await seedGame({
      slug: 'nodev',
      title: 'Без разработчика',
      developer: null,
      publishers: ['Publisher Only'],
    });

    const { body } = await server.request(`/api/games/${game.id}`);
    const dto = body as { developer: string | null; developerStatus: string };

    // Подмена разработчика издателем запрещена (ADR-0003)
    expect(dto.developer).toBeNull();
    expect(dto.developerStatus).toBe('unknown');
  });

  it('отдаёт только активные платформы и сохраняет scope', async () => {
    const game = await seedGame({
      slug: 'plat',
      title: 'Игра',
      platforms: [{ slug: 'pc', name: 'PC', metascore: 82 }],
      inactivePlatform: { slug: 'xbox-one', name: 'Xbox One' },
    });

    const { body } = await server.request(`/api/games/${game.id}`);
    const dto = body as {
      platforms: { slug: string; metascoreScope: string; userscoreScope: string }[];
    };

    expect(dto.platforms.map((p) => p.slug)).toEqual(['pc']);
    // Различие scope не теряется при переводе в DTO (ADR-0008)
    expect(dto.platforms[0]!.metascoreScope).toBe('platform');
    expect(dto.platforms[0]!.userscoreScope).toBe('overall');
  });

  it('similar всегда пустой массив в этой фазе', async () => {
    const game = await seedGame({ slug: 'sim', title: 'Игра' });

    const { body } = await server.request(`/api/games/${game.id}`);
    expect((body as { similar: unknown[] }).similar).toEqual([]);
  });

  it('несуществующая игра даёт 404 со стабильным кодом', async () => {
    const { status, body } = await server.request(
      '/api/games/00000000-0000-4000-8000-000000000000',
    );
    const payload = body as { error: { code: string; requestId: string } };

    expect(status).toBe(404);
    expect(payload.error.code).toBe('GAME_NOT_FOUND');
    expect(payload.error.requestId).toBeTruthy();
  });

  it('некорректный UUID даёт 400, а не 404', async () => {
    const { status, body } = await server.request('/api/games/not-a-uuid');
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });
});

// ============================================================================
// GET /api/platforms
// ============================================================================

describe('GET /api/platforms', () => {
  it('возвращает активные платформы', async () => {
    await seedGame({
      slug: 'g1',
      title: 'Игра',
      platforms: [
        { slug: 'pc', name: 'PC', metascore: 80 },
        { slug: 'playstation-5', name: 'PlayStation 5', metascore: 85 },
      ],
    });

    const { status, body } = await server.request('/api/platforms');
    const payload = body as { items: { slug: string; name: string }[] };

    expect(status).toBe(200);
    expect(payload.items.map((p) => p.slug).sort()).toEqual(['pc', 'playstation-5']);
  });

  it('не показывает отключённые платформы', async () => {
    await seedGame({
      slug: 'g1',
      title: 'Игра',
      platforms: [{ slug: 'pc', name: 'PC', metascore: 80 }],
      inactivePlatform: { slug: 'xbox-one', name: 'Xbox One' },
    });

    const { body } = await server.request('/api/platforms');
    const payload = body as { items: { slug: string }[] };

    expect(payload.items.map((p) => p.slug)).toEqual(['pc']);
  });
});

// ============================================================================
// GET /api/games/:id/analysis
// ============================================================================

describe('GET /api/games/:id/analysis', () => {
  it('разделяет анализ критиков и пользователей', async () => {
    const game = await seedGame({ slug: 'an', title: 'Игра' });

    await summaries.save(
      summaryOf({ gameId: game.id, kind: 'user', summary: 'Мнение игроков' }),
    );
    await summaries.save(
      summaryOf({ gameId: game.id, kind: 'critic', summary: 'Мнение критиков' }),
    );

    const { status, body } = await server.request(`/api/games/${game.id}/analysis`);
    const dto = body as {
      critic: { summary: string } | null;
      user: { summary: string } | null;
    };

    expect(status).toBe(200);
    expect(dto.critic?.summary).toBe('Мнение критиков');
    expect(dto.user?.summary).toBe('Мнение игроков');
  });

  it('только пользовательский анализ — critic остаётся null', async () => {
    const game = await seedGame({ slug: 'only-user', title: 'Игра' });
    await summaries.save(summaryOf({ gameId: game.id, kind: 'user' }));

    const { body } = await server.request(`/api/games/${game.id}/analysis`);
    const dto = body as { critic: unknown; user: unknown };

    // null означает «анализа нет», а не «мнений нет»
    expect(dto.critic).toBeNull();
    expect(dto.user).not.toBeNull();
  });

  it('сохраняет поля полноты из БД', async () => {
    const game = await seedGame({ slug: 'cov', title: 'Игра' });
    await summaries.save(
      summaryOf({
        gameId: game.id,
        kind: 'user',
        analyzedCount: 37,
        totalAvailable: 412,
        coverage: 'sample',
        snapshotCompleteness: 'partial',
      }),
    );

    const { body } = await server.request(`/api/games/${game.id}/analysis`);
    const user = (body as { user: Record<string, unknown> }).user;

    expect(user.analyzedCount).toBe(37);
    expect(user.totalAvailable).toBe(412);
    expect(user.coverage).toBe('sample');
    expect(user.snapshotCompleteness).toBe('partial');
  });

  it('неполный снимок виден в ответе', async () => {
    const game = await seedGame({ slug: 'inc', title: 'Игра' });
    await summaries.save(
      summaryOf({
        gameId: game.id,
        kind: 'critic',
        snapshotCompleteness: 'incomplete',
        coverage: 'sample',
      }),
    );

    const { body } = await server.request(`/api/games/${game.id}/analysis`);
    const critic = (body as { critic: Record<string, unknown> }).critic;

    expect(critic.snapshotCompleteness).toBe('incomplete');
  });

  it('сохраняет ссылки на свидетельства', async () => {
    const game = await seedGame({ slug: 'ev', title: 'Игра' });
    await summaries.save(
      summaryOf({
        gameId: game.id,
        kind: 'user',
        liked: [{ text: 'Графика', evidenceRefs: ['r1', 'r7'] }],
        themes: [
          {
            name: 'визуал',
            sentiment: 'positive',
            description: 'Хвалят картинку',
            evidenceRefs: ['r7'],
          },
        ],
      }),
    );

    const { body } = await server.request(`/api/games/${game.id}/analysis`);
    const user = body as {
      user: {
        liked: { evidenceRefs: string[] }[];
        themes: { evidenceRefs: string[] }[];
      };
    };

    expect(user.user.liked[0]!.evidenceRefs).toEqual(['r1', 'r7']);
    expect(user.user.themes[0]!.evidenceRefs).toEqual(['r7']);
  });

  it('сохраняет модель, версию промпта и время анализа', async () => {
    const game = await seedGame({ slug: 'meta', title: 'Игра' });
    await summaries.save(
      summaryOf({ gameId: game.id, kind: 'user', model: 'vendor/model-x', promptVersion: 'v9' }),
    );

    const { body } = await server.request(`/api/games/${game.id}/analysis`);
    const user = (body as { user: Record<string, unknown> }).user;

    expect(user.model).toBe('vendor/model-x');
    expect(user.promptVersion).toBe('v9');
    expect(user.analyzedAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('фильтрует по платформе', async () => {
    const game = await seedGame({ slug: 'plat-iso', title: 'Игра' });

    await summaries.save(
      summaryOf({
        gameId: game.id,
        kind: 'critic',
        platformSlug: 'pc',
        summary: 'Анализ PC',
      }),
    );
    await summaries.save(
      summaryOf({
        gameId: game.id,
        kind: 'critic',
        platformSlug: 'playstation-5',
        summary: 'Анализ PS5',
      }),
    );

    const pc = await server.request(`/api/games/${game.id}/analysis?platform=pc`);
    const ps5 = await server.request(
      `/api/games/${game.id}/analysis?platform=playstation-5`,
    );

    expect((pc.body as { critic: { summary: string } }).critic.summary).toBe('Анализ PC');
    expect((ps5.body as { critic: { summary: string } }).critic.summary).toBe('Анализ PS5');
  });

  it('без анализа возвращает оба поля null, а не 404', async () => {
    const game = await seedGame({ slug: 'none', title: 'Игра' });

    const { status, body } = await server.request(`/api/games/${game.id}/analysis`);
    const dto = body as { critic: unknown; user: unknown };

    expect(status).toBe(200);
    expect(dto.critic).toBeNull();
    expect(dto.user).toBeNull();
  });

  it('несуществующая игра даёт 404', async () => {
    const { status } = await server.request(
      '/api/games/00000000-0000-4000-8000-000000000000/analysis',
    );
    expect(status).toBe(404);
  });

  it('неуспешный анализ отдаётся со своим статусом', async () => {
    const game = await seedGame({ slug: 'failed', title: 'Игра' });
    await summaries.save(
      summaryOf({
        gameId: game.id,
        kind: 'user',
        status: 'insufficient_reviews',
        summary: null,
        liked: [],
        disliked: [],
        themes: [],
        confidence: null,
        inputHash: null,
        analyzedCount: 0,
        coverage: null,
      }),
    );

    const { body } = await server.request(`/api/games/${game.id}/analysis`);
    const user = (body as { user: Record<string, unknown> }).user;

    expect(user.status).toBe('insufficient_reviews');
    expect(user.summary).toBeNull();
  });
});

// ============================================================================
// GET /api/games/:id/reviews
// ============================================================================

describe('GET /api/games/:id/reviews', () => {
  it('отдаёт отзывы критиков', async () => {
    const game = await seedGame({ slug: 'rc', title: 'Игра' });
    await seedReviews(game.id, 'critic', [criticReview('ign'), criticReview('gamespot')]);

    const { status, body } = await server.request(
      `/api/games/${game.id}/reviews?kind=critic`,
    );
    const payload = body as { items: { kind: string }[]; pagination: { total: number } };

    expect(status).toBe(200);
    expect(payload.items).toHaveLength(2);
    expect(payload.items.every((r) => r.kind === 'critic')).toBe(true);
    expect(payload.pagination.total).toBe(2);
  });

  it('разделяет отзывы критиков и пользователей', async () => {
    const game = await seedGame({ slug: 'mix', title: 'Игра' });
    await seedReviews(game.id, 'critic', [criticReview('ign')]);
    await seedReviews(game.id, 'user', [userReview('u1'), userReview('u2')]);

    const critics = await server.request(`/api/games/${game.id}/reviews?kind=critic`);
    const users = await server.request(`/api/games/${game.id}/reviews?kind=user`);

    expect((critics.body as { items: unknown[] }).items).toHaveLength(1);
    expect((users.body as { items: unknown[] }).items).toHaveLength(2);
  });

  it('фильтрует по платформе', async () => {
    const game = await seedGame({ slug: 'rp', title: 'Игра' });
    await seedReviews(game.id, 'critic', [criticReview('ign', 'pc')], 'pc');
    await seedReviews(
      game.id,
      'critic',
      [criticReview('edge', 'playstation-5')],
      'playstation-5',
    );

    const { body } = await server.request(
      `/api/games/${game.id}/reviews?kind=critic&platform=playstation-5`,
    );
    const payload = body as { items: { platformSlug: string }[] };

    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]!.platformSlug).toBe('playstation-5');
  });

  it('делит отзывы на страницы', async () => {
    const game = await seedGame({ slug: 'rpage', title: 'Игра' });
    await seedReviews(
      game.id,
      'user',
      Array.from({ length: 7 }, (_, i) => userReview(`u-${i}`)),
    );

    const first = await server.request(
      `/api/games/${game.id}/reviews?kind=user&page=1&pageSize=3`,
    );
    const second = await server.request(
      `/api/games/${game.id}/reviews?kind=user&page=2&pageSize=3`,
    );

    const p1 = first.body as { items: { id: string }[]; pagination: { total: number } };
    const p2 = second.body as { items: { id: string }[] };

    expect(p1.items).toHaveLength(3);
    expect(p1.pagination.total).toBe(7);

    const ids1 = p1.items.map((i) => i.id);
    const ids2 = p2.items.map((i) => i.id);
    expect(ids1.filter((id) => ids2.includes(id))).toHaveLength(0);
  });

  it('отклоняет недопустимый kind', async () => {
    const game = await seedGame({ slug: 'bk', title: 'Игра' });

    const { status, body } = await server.request(
      `/api/games/${game.id}/reviews?kind=journalist`,
    );
    const payload = body as { error: { code: string; details?: { allowed: string[] } } };

    expect(status).toBe(400);
    expect(payload.error.code).toBe('VALIDATION_ERROR');
    expect(payload.error.details?.allowed).toEqual(['critic', 'user']);
  });

  it('отклоняет недопустимый platform', async () => {
    const game = await seedGame({ slug: 'bp', title: 'Игра' });

    const { status } = await server.request(
      `/api/games/${game.id}/reviews?kind=user&platform=${encodeURIComponent("pc'; DROP TABLE games; --")}`,
    );
    expect(status).toBe(400);
  });

  it('отклоняет некорректную страницу', async () => {
    const game = await seedGame({ slug: 'bpage', title: 'Игра' });

    const { status } = await server.request(`/api/games/${game.id}/reviews?page=-5`);
    expect(status).toBe(400);
  });

  it('несуществующая игра даёт 404', async () => {
    const { status } = await server.request(
      '/api/games/00000000-0000-4000-8000-000000000000/reviews',
    );
    expect(status).toBe(404);
  });
});
