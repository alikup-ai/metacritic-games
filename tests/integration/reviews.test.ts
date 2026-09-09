import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbPool } from '../../src/shared/db/pool.js';
import { PostgresUnitOfWork } from '../../src/shared/db/unit-of-work.js';
import { PostgresGameRepository } from '../../src/modules/catalog/infrastructure/postgres-game-repository.js';
import {
  hashContent,
  PostgresReviewRepository,
  PostgresReviewSnapshotRepository,
} from '../../src/modules/reviews/infrastructure/postgres-review-repository.js';
import { SyncReviewsUseCase } from '../../src/modules/reviews/application/sync-reviews.js';
import { RecordingReviewEventSink } from '../../src/modules/reviews/domain/review-events.js';
import { reviewKey } from '../../src/modules/reviews/domain/review.js';
import { IngestionError } from '../../src/modules/ingestion/domain/ingestion-errors.js';
import type {
  NormalizedReview,
  NormalizedReviewPage,
  ReviewKind,
} from '../../src/modules/reviews/domain/review.js';
import type {
  FetchReviewPageParams,
  ReviewSource,
} from '../../src/modules/reviews/domain/review-ports.js';
import { createTestPool, setupSchema, truncateAll } from './helpers.js';

/**
 * Интеграционные тесты отзывов на РЕАЛЬНОЙ PostgreSQL.
 * Источник подменяется; ограничения целостности и гонки — настоящие.
 */

let pool: DbPool;
let games: PostgresGameRepository;
let reviews: PostgresReviewRepository;
let snapshots: PostgresReviewSnapshotRepository;
let unitOfWork: PostgresUnitOfWork;
let gameId: string;

function userReview(id: string, score = 8, quote = `Отзыв ${id}`): NormalizedReview {
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

function criticReview(
  slug: string,
  score = 85,
  platform = 'pc',
  quote = `Рецензия ${slug}`,
): NormalizedReview {
  return {
    identity: { kind: 'critic', publicationSlug: slug },
    platformSlug: platform,
    score,
    quote,
    author: slug.toUpperCase(),
    reviewUrl: `https://example.test/${slug}`,
    reviewDate: '2026-01-01',
    sourceVersion: null,
    spoiler: null,
  };
}

/** Источник, отдающий заданные страницы. */
class StubSource implements ReviewSource {
  constructor(
    private pages: NormalizedReview[][],
    private failAfter: number | null = null,
    /** Объявленное источником количество; по умолчанию — сумма страниц. */
    private declaredTotal: number | null = null,
  ) {}
  calls = 0;

  setPages(pages: NormalizedReview[][]): void {
    this.pages = pages;
    this.calls = 0;
  }

  async fetchReviewPage(params: FetchReviewPageParams): Promise<NormalizedReviewPage> {
    this.calls += 1;
    if (this.failAfter !== null && this.calls > this.failAfter) {
      throw new Error('Сбой источника');
    }

    const index = Math.floor(params.offset / params.limit);
    const items = this.pages[index] ?? [];
    const total =
      this.declaredTotal ?? this.pages.reduce((sum, p) => sum + p.length, 0);

    return {
      kind: params.kind,
      platformSlug: params.platform ?? 'default',
      reviews: items,
      totalAvailable: total,
      malformed: 0,
    };
  }
}

function makeUseCase(source: ReviewSource, overrides = {}) {
  const events = new RecordingReviewEventSink();
  const useCase = new SyncReviewsUseCase({
    source,
    reviews,
    snapshots,
    unitOfWork,
    events,
    hash: hashContent,
    maxPages: 10,
    pageSize: 50,
    maxReviews: 0,
    ...overrides,
  });
  return { useCase, events };
}

const params = (kind: ReviewKind = 'user', platform = 'pc') => ({
  gameId,
  sourceSlug: 'test-game',
  kind,
  platform,
});

beforeAll(async () => {
  pool = createTestPool();
  await setupSchema(pool);
  games = new PostgresGameRepository(pool);
  reviews = new PostgresReviewRepository(pool);
  snapshots = new PostgresReviewSnapshotRepository(pool);
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

describe('Идемпотентность', () => {
  it('один и тот же отзыв дважды даёт одну строку', async () => {
    const source = new StubSource([[userReview('u1')]]);
    const { useCase } = makeUseCase(source);

    const first = await useCase.execute(params());
    expect(first.created).toBe(1);

    // Сбрасываем снимок, чтобы проверить именно запись, а не пропуск
    await pool.query('DELETE FROM review_snapshots');
    const second = await useCase.execute(params());

    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(await reviews.countByGame({ gameId, kind: 'user', platformSlug: 'pc' })).toBe(1);
  });

  it('одна и та же страница дважды не создаёт дубликатов', async () => {
    const source = new StubSource([[userReview('u1'), userReview('u2')]]);
    const { useCase } = makeUseCase(source);

    await useCase.execute(params());
    await pool.query('DELETE FROM review_snapshots');
    await useCase.execute(params());

    expect(await reviews.countByGame({ gameId, kind: 'user', platformSlug: 'pc' })).toBe(2);
  });

  it('дубликат между страницами даёт одну строку', async () => {
    const source = new StubSource([
      [userReview('u1'), userReview('u2')],
      // u2 повторяется на второй странице
      [userReview('u2'), userReview('u3')],
    ]);
    const { useCase } = makeUseCase(source, { pageSize: 2 });

    const result = await useCase.execute(params());

    expect(result.created).toBe(3);
    expect(await reviews.countByGame({ gameId, kind: 'user', platformSlug: 'pc' })).toBe(3);
  });
});

describe('Изменения отзывов', () => {
  it('изменённый отзыв обновляется, а не дублируется', async () => {
    const source = new StubSource([[userReview('u1', 8, 'Первая версия')]]);
    const { useCase } = makeUseCase(source);

    await useCase.execute(params());

    source.setPages([[userReview('u1', 9, 'Вторая версия')]]);
    const second = await useCase.execute(params());

    expect(second.updated).toBe(1);
    expect(second.created).toBe(0);
    expect(await reviews.countByGame({ gameId, kind: 'user', platformSlug: 'pc' })).toBe(1);

    const stored = await reviews.findByGame({ gameId, kind: 'user', platformSlug: 'pc' });
    expect(stored[0]!.quote).toBe('Вторая версия');
    expect(stored[0]!.score).toBe(9);
  });

  it('first_seen_at не меняется при обновлении', async () => {
    const source = new StubSource([[userReview('u1', 8, 'v1')]]);
    const { useCase } = makeUseCase(source);

    await useCase.execute(params());
    const before = (await reviews.findByGame({ gameId, kind: 'user', platformSlug: 'pc' }))[0]!;

    await new Promise((r) => setTimeout(r, 30));
    source.setPages([[userReview('u1', 9, 'v2')]]);
    await useCase.execute(params());

    const after = (await reviews.findByGame({ gameId, kind: 'user', platformSlug: 'pc' }))[0]!;
    expect(after.firstSeenAt.getTime()).toBe(before.firstSeenAt.getTime());
    expect(after.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before.lastSeenAt.getTime());
  });

  it('новый отзыв добавляется к существующим', async () => {
    const source = new StubSource([[userReview('u1')]]);
    const { useCase } = makeUseCase(source);

    await useCase.execute(params());

    source.setPages([[userReview('u1'), userReview('u2')]]);
    const second = await useCase.execute(params());

    expect(second.created).toBe(1);
    expect(second.unchanged).toBe(1);
    expect(await reviews.countByGame({ gameId, kind: 'user', platformSlug: 'pc' })).toBe(2);
  });

  it('неизменный набор пропускается по отпечатку', async () => {
    const source = new StubSource([[userReview('u1')]]);
    const { useCase, events } = makeUseCase(source);

    await useCase.execute(params());
    const second = await useCase.execute(params());

    expect(second.skipped).toBe(true);
    expect(events.ofType('review_snapshot_skipped')).toHaveLength(1);
  });
});

describe('Исчезнувшие отзывы', () => {
  it('удаляются при полном снимке', async () => {
    const source = new StubSource([[userReview('u1'), userReview('u2')]]);
    const { useCase } = makeUseCase(source);

    await useCase.execute(params());

    source.setPages([[userReview('u1')]]);
    const second = await useCase.execute(params());

    expect(second.deleted).toBe(1);
    expect(await reviews.countByGame({ gameId, kind: 'user', platformSlug: 'pc' })).toBe(1);
  });

  it('СОХРАНЯЮТСЯ при частичном обходе (ограничение лимитом)', async () => {
    const source = new StubSource([[userReview('u1'), userReview('u2')]]);
    const { useCase } = makeUseCase(source);
    await useCase.execute(params());

    // Обход ограничен одним отзывом — снимок partial
    source.setPages([[userReview('u1')]]);
    const limited = makeUseCase(source, { maxReviews: 1 });
    const second = await limited.useCase.execute(params());

    expect(second.completeness).toBe('partial');
    expect(second.deleted).toBe(0);
    // Второй отзыв не удалён: он мог просто не попасть в выборку
    expect(await reviews.countByGame({ gameId, kind: 'user', platformSlug: 'pc' })).toBe(2);
  });

  it('СОХРАНЯЮТСЯ при сбое источника', async () => {
    const source = new StubSource([[userReview('u1'), userReview('u2')]]);
    const { useCase } = makeUseCase(source);
    await useCase.execute(params());

    // Источник заявляет 5 отзывов, отдаёт 1 и падает на втором запросе:
    // обход обрывается, набор заведомо неполон.
    const failing = new StubSource([[userReview('u1')]], 1, 5);
    const degraded = makeUseCase(failing, { pageSize: 1 });
    const second = await degraded.useCase.execute(params());

    expect(second.completeness).toBe('incomplete');
    expect(second.deleted).toBe(0);
    expect(await reviews.countByGame({ gameId, kind: 'user', platformSlug: 'pc' })).toBe(2);
  });
});

describe('Изоляция критиков и пользователей', () => {
  it('одинаковый ключ не смешивает типы', async () => {
    const userSource = new StubSource([[userReview('ign')]]);
    const criticSource = new StubSource([[criticReview('ign')]]);

    await makeUseCase(userSource).useCase.execute(params('user'));
    await makeUseCase(criticSource).useCase.execute(params('critic'));

    expect(await reviews.countByGame({ gameId, kind: 'user', platformSlug: 'pc' })).toBe(1);
    expect(await reviews.countByGame({ gameId, kind: 'critic', platformSlug: 'pc' })).toBe(1);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reviews WHERE game_id = $1',
      [gameId],
    );
    expect(Number(rows[0]!.count)).toBe(2);
  });

  it('снимки типов независимы', async () => {
    await makeUseCase(new StubSource([[userReview('u1')]])).useCase.execute(params('user'));
    await makeUseCase(new StubSource([[criticReview('ign')]])).useCase.execute(
      params('critic'),
    );

    const userSnap = await snapshots.find({ gameId, kind: 'user', platformSlug: 'pc' });
    const criticSnap = await snapshots.find({ gameId, kind: 'critic', platformSlug: 'pc' });

    expect(userSnap).not.toBeNull();
    expect(criticSnap).not.toBeNull();
    expect(userSnap!.fingerprint).not.toBe(criticSnap!.fingerprint);
  });

  it('удаление пользовательских не затрагивает критические', async () => {
    await makeUseCase(new StubSource([[userReview('u1'), userReview('u2')]])).useCase.execute(
      params('user'),
    );
    await makeUseCase(new StubSource([[criticReview('ign')]])).useCase.execute(
      params('critic'),
    );

    // Пользовательский отзыв исчез
    await makeUseCase(new StubSource([[userReview('u1')]])).useCase.execute(params('user'));

    expect(await reviews.countByGame({ gameId, kind: 'user', platformSlug: 'pc' })).toBe(1);
    expect(await reviews.countByGame({ gameId, kind: 'critic', platformSlug: 'pc' })).toBe(1);
  });

  it('БД отвергает user-отзыв со слагом издания', async () => {
    await expect(
      pool.query(
        `INSERT INTO reviews (game_id, kind, platform_slug, publication_slug, quote, content_hash)
         VALUES ($1, 'user', 'pc', 'ign', 'Q', 'h')`,
        [gameId],
      ),
    ).rejects.toThrow(/reviews_identity_valid/);
  });

  it('БД отвергает оценку вне шкалы типа', async () => {
    await expect(
      pool.query(
        `INSERT INTO reviews (game_id, kind, platform_slug, external_id, score, quote, content_hash)
         VALUES ($1, 'user', 'pc', 'u1', 55, 'Q', 'h')`,
        [gameId],
      ),
    ).rejects.toThrow(/reviews_score_range/);
  });
});

describe('Семантика платформ', () => {
  it('одно издание на двух платформах даёт ДВЕ строки', async () => {
    await makeUseCase(new StubSource([[criticReview('ign', 90, 'pc')]])).useCase.execute(
      params('critic', 'pc'),
    );
    await makeUseCase(
      new StubSource([[criticReview('ign', 88, 'xbox-one')]]),
    ).useCase.execute(params('critic', 'xbox-one'));

    expect(await reviews.countByGame({ gameId, kind: 'critic', platformSlug: 'pc' })).toBe(1);
    expect(
      await reviews.countByGame({ gameId, kind: 'critic', platformSlug: 'xbox-one' }),
    ).toBe(1);
  });

  it('снимки платформ независимы', async () => {
    await makeUseCase(new StubSource([[userReview('u1')]])).useCase.execute(
      params('user', 'pc'),
    );

    const pcSnap = await snapshots.find({ gameId, kind: 'user', platformSlug: 'pc' });
    const switchSnap = await snapshots.find({
      gameId,
      kind: 'user',
      platformSlug: 'switch',
    });

    expect(pcSnap).not.toBeNull();
    expect(switchSnap).toBeNull();
  });
});

describe('Снимки', () => {
  it('сохраняет метаданные полноты', async () => {
    const source = new StubSource([[userReview('u1'), userReview('u2')]]);
    await makeUseCase(source).useCase.execute(params());

    const snap = await snapshots.find({ gameId, kind: 'user', platformSlug: 'pc' });

    expect(snap!.reviewCount).toBe(2);
    expect(snap!.completeness).toBe('complete');
    expect(snap!.totalAvailable).toBe(2);
    expect(snap!.malformedCount).toBe(0);
  });

  it('неполный снимок не пропускается по отпечатку', async () => {
    const failing = new StubSource([[userReview('u1')]], 1, 5);
    const { useCase } = makeUseCase(failing, { pageSize: 1 });

    const first = await useCase.execute(params());
    expect(first.completeness).toBe('incomplete');

    // Повтор должен выполнить запись, а не пропустить по совпавшему отпечатку
    const retry = new StubSource([[userReview('u1')]]);
    const second = await makeUseCase(retry).useCase.execute(params());
    expect(second.skipped).toBe(false);
  });

  it('пустой набор сохраняется как валидный снимок', async () => {
    const source = new StubSource([[]]);
    const result = await makeUseCase(source).useCase.execute(params());

    expect(result.fetched).toBe(0);
    expect(result.completeness).toBe('complete');

    const snap = await snapshots.find({ gameId, kind: 'user', platformSlug: 'pc' });
    expect(snap!.reviewCount).toBe(0);
  });
});

describe('Атомарность', () => {
  it('ошибка внутри транзакции не оставляет частичных данных', async () => {
    const source = new StubSource([[userReview('u1')]]);

    // Снимок падает при сохранении — отзывы должны откатиться
    const brokenSnapshots = {
      find: async () => null,
      save: async () => {
        throw new Error('Сбой записи снимка');
      },
    };

    const useCase = new SyncReviewsUseCase({
      source,
      reviews,
      snapshots: brokenSnapshots,
      unitOfWork,
      hash: hashContent,
      maxPages: 10,
      pageSize: 50,
      maxReviews: 0,
    });

    await expect(useCase.execute(params())).rejects.toThrow('Сбой записи снимка');

    // Ни отзывов, ни снимка
    expect(await reviews.countByGame({ gameId, kind: 'user', platformSlug: 'pc' })).toBe(0);
    expect(await snapshots.find({ gameId, kind: 'user', platformSlug: 'pc' })).toBeNull();
  });

  it('сбой сети на первой странице даёт пустой incomplete-снимок', async () => {
    const source: ReviewSource = {
      fetchReviewPage: vi.fn(async () => {
        throw new Error('Сеть недоступна');
      }),
    };

    const { useCase } = makeUseCase(source);
    const result = await useCase.execute(params());

    // Обход не бросает ошибку: собранное (ничего) сохраняется с пометкой
    // неполноты, чтобы следующий запуск повторил попытку.
    expect(result.completeness).toBe('incomplete');
    expect(result.fetched).toBe(0);
    expect(await reviews.countByGame({ gameId, kind: 'user', platformSlug: 'pc' })).toBe(0);

    // Снимок помечен неполным — он не заблокирует повторный обход
    const snap = await snapshots.find({ gameId, kind: 'user', platformSlug: 'pc' });
    expect(snap!.completeness).toBe('incomplete');
  });

  it('блокировка источника пробрасывается и не создаёт снимка', async () => {
    const source: ReviewSource = {
      fetchReviewPage: vi.fn(async () => {
        throw new IngestionError('blocked', 'Доступ запрещён', { status: 403 });
      }),
    };

    const { useCase, events } = makeUseCase(source);
    await expect(useCase.execute(params())).rejects.toMatchObject({
      category: 'blocked',
    });

    expect(await snapshots.find({ gameId, kind: 'user', platformSlug: 'pc' })).toBeNull();
    expect(events.ofType('review_fetch_failed')).toHaveLength(1);
  });
});

describe('Конкурентность', () => {
  it('параллельная синхронизация одного набора не даёт дубликатов', async () => {
    const build = () => makeUseCase(new StubSource([[userReview('u1'), userReview('u2')]]));

    const results = await Promise.allSettled([
      build().useCase.execute(params()),
      build().useCase.execute(params()),
      build().useCase.execute(params()),
    ]);

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(0);

    expect(await reviews.countByGame({ gameId, kind: 'user', platformSlug: 'pc' })).toBe(2);
  });

  it('параллельная обработка критиков и пользователей не конфликтует', async () => {
    await Promise.all([
      makeUseCase(new StubSource([[userReview('u1')]])).useCase.execute(params('user')),
      makeUseCase(new StubSource([[criticReview('ign')]])).useCase.execute(params('critic')),
    ]);

    expect(await reviews.countByGame({ gameId, kind: 'user', platformSlug: 'pc' })).toBe(1);
    expect(await reviews.countByGame({ gameId, kind: 'critic', platformSlug: 'pc' })).toBe(1);
  });

  it('гонка на уникальном индексе разрешается СУБД', async () => {
    const build = () => makeUseCase(new StubSource([[userReview('same')]]));

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => build().useCase.execute(params())),
    );

    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM reviews
       WHERE game_id = $1 AND external_id = 'same'`,
      [gameId],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });
});

describe('События', () => {
  it('публикуется полная последовательность', async () => {
    const source = new StubSource([[userReview('u1')]]);
    const { useCase, events } = makeUseCase(source);

    await useCase.execute(params());

    const types = events.events.map((e) => e.type);
    expect(types).toContain('review_fetch_started');
    expect(types).toContain('review_fetch_completed');
    expect(types).toContain('review_snapshot_created');
  });

  it('события не содержат текстов отзывов', async () => {
    const secret = 'УНИКАЛЬНЫЙ_ТЕКСТ_ОТЗЫВА_12345';
    const source = new StubSource([[userReview('u1', 8, secret)]]);
    const { useCase, events } = makeUseCase(source);

    await useCase.execute(params());

    expect(JSON.stringify(events.events)).not.toContain(secret);
  });

  it('некорректные записи публикуют review_parse_failed', async () => {
    const source: ReviewSource = {
      fetchReviewPage: async (p) => ({
        kind: p.kind,
        platformSlug: p.platform ?? 'default',
        reviews: [userReview('u1')],
        totalAvailable: 1,
        malformed: 2,
      }),
    };

    const { useCase, events } = makeUseCase(source);
    await useCase.execute(params());

    expect(events.ofType('review_parse_failed')[0]!.malformed).toBe(2);
  });
});

describe('Ключи отзывов', () => {
  it('ключ пользователя и критика не пересекаются', () => {
    expect(reviewKey({ kind: 'user', externalId: 'x' })).not.toBe(
      reviewKey({ kind: 'critic', publicationSlug: 'x' }),
    );
  });
});
