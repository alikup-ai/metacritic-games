import { describe, expect, it, vi } from 'vitest';
import {
  fetchAllReviews,
  resolveCompleteness,
} from '../../src/modules/reviews/application/fetch-reviews.js';
import { IngestionError } from '../../src/modules/ingestion/domain/ingestion-errors.js';
import type {
  NormalizedReview,
  NormalizedReviewPage,
} from '../../src/modules/reviews/domain/review.js';
import type {
  FetchReviewPageParams,
  ReviewSource,
} from '../../src/modules/reviews/domain/review-ports.js';

/** Тесты пагинации: без сети и без БД. */

function userReview(id: string, score = 8): NormalizedReview {
  return {
    identity: { kind: 'user', externalId: id },
    platformSlug: 'pc',
    score,
    quote: `Отзыв ${id}`,
    author: null,
    reviewUrl: null,
    reviewDate: null,
    sourceVersion: null,
    spoiler: null,
  };
}

/** Источник, отдающий заранее заданные страницы. */
class StubSource implements ReviewSource {
  readonly calls: FetchReviewPageParams[] = [];

  constructor(
    private readonly pages: NormalizedReviewPage[],
    private readonly failAt: number | null = null,
  ) {}

  async fetchReviewPage(params: FetchReviewPageParams): Promise<NormalizedReviewPage> {
    this.calls.push(params);

    if (this.failAt !== null && this.calls.length > this.failAt) {
      throw new IngestionError('network', 'Обрыв связи', {});
    }

    const index = Math.floor(params.offset / params.limit);
    return (
      this.pages[index] ?? {
        kind: params.kind,
        platformSlug: params.platform ?? 'default',
        reviews: [],
        totalAvailable: 0,
        malformed: 0,
      }
    );
  }
}

function page(
  reviews: NormalizedReview[],
  totalAvailable: number,
  malformed = 0,
): NormalizedReviewPage {
  return { kind: 'user', platformSlug: 'pc', reviews, totalAvailable, malformed };
}

const deps = (source: ReviewSource, overrides = {}) => ({
  source,
  maxPages: 10,
  pageSize: 2,
  maxReviews: 0,
  ...overrides,
});

const params = { sourceSlug: 'game', kind: 'user' as const, platform: 'pc' };

describe('Обход страниц', () => {
  it('собирает отзывы со всех страниц', async () => {
    const source = new StubSource([
      page([userReview('u1'), userReview('u2')], 4),
      page([userReview('u3'), userReview('u4')], 4),
    ]);

    const result = await fetchAllReviews(deps(source), params);

    expect(result.reviews).toHaveLength(4);
    expect(result.completeness).toBe('complete');
    expect(result.stopReason).toBe('all_fetched');
  });

  it('останавливается на пустой странице', async () => {
    const source = new StubSource([page([userReview('u1')], 99), page([], 99)]);

    const result = await fetchAllReviews(deps(source), params);

    expect(result.reviews).toHaveLength(1);
    expect(result.stopReason).toBe('empty_page');
  });

  it('игра без отзывов — валидный пустой результат', async () => {
    const source = new StubSource([page([], 0)]);

    const result = await fetchAllReviews(deps(source), params);

    expect(result.reviews).toHaveLength(0);
    expect(result.completeness).toBe('complete');
    expect(result.stopReason).toBe('all_fetched');
  });

  it('соблюдает предел страниц', async () => {
    // Источник бесконечно отдаёт разные отзывы
    const source: ReviewSource = {
      fetchReviewPage: vi.fn(async (p: FetchReviewPageParams) =>
        page([userReview(`u${p.offset}a`), userReview(`u${p.offset}b`)], 1000),
      ),
    };

    const result = await fetchAllReviews(deps(source, { maxPages: 3 }), params);

    expect(result.pagesScanned).toBe(3);
    expect(result.stopReason).toBe('page_limit');
    // Защитный предел означает неполный набор
    expect(result.completeness).toBe('incomplete');
  });

  it('соблюдает предел числа отзывов', async () => {
    const source: ReviewSource = {
      fetchReviewPage: vi.fn(async (p: FetchReviewPageParams) =>
        page([userReview(`u${p.offset}a`), userReview(`u${p.offset}b`)], 1000),
      ),
    };

    const result = await fetchAllReviews(deps(source, { maxReviews: 3 }), params);

    expect(result.reviews).toHaveLength(3);
    expect(result.stopReason).toBe('limit_reached');
    // Сознательное ограничение — штатный режим, не деградация
    expect(result.completeness).toBe('partial');
  });
});

describe('Защита от дубликатов и зацикливания', () => {
  it('дубликаты между страницами отбрасываются', async () => {
    const source = new StubSource([
      page([userReview('u1'), userReview('u2')], 3),
      // u2 повторяется: список сдвинулся при добавлении нового отзыва
      page([userReview('u2'), userReview('u3')], 3),
    ]);

    const result = await fetchAllReviews(deps(source), params);

    expect(result.reviews).toHaveLength(3);
    const ids = result.reviews.map((r) =>
      r.identity.kind === 'user' ? r.identity.externalId : '',
    );
    expect(new Set(ids).size).toBe(3);
  });

  it('повтор одной и той же страницы прекращает обход', async () => {
    const same = [userReview('u1'), userReview('u2')];
    const source: ReviewSource = {
      fetchReviewPage: vi.fn(async () => page(same, 1000)),
    };

    const result = await fetchAllReviews(deps(source), params);

    expect(result.stopReason).toBe('repeated_page');
    expect(result.reviews).toHaveLength(2);
    // Источник повторяется — набор мог остаться неполным
    expect(result.completeness).toBe('incomplete');
  });

  it('нет бесконечного цикла при постоянно одинаковом ответе', async () => {
    const source: ReviewSource = {
      fetchReviewPage: vi.fn(async () => page([userReview('u1')], 9999)),
    };

    const result = await fetchAllReviews(deps(source, { maxPages: 50 }), params);

    expect(result.pagesScanned).toBeLessThanOrEqual(3);
    expect(result.stopReason).toBe('repeated_page');
  });

  it('страница только из уже виденных отзывов прекращает обход', async () => {
    const source = new StubSource([
      page([userReview('u1'), userReview('u2')], 100),
      // Другой состав, но все уже собраны
      page([userReview('u2'), userReview('u1')], 100),
    ]);

    const result = await fetchAllReviews(deps(source), params);
    expect(result.reviews).toHaveLength(2);
    expect(result.stopReason).toBe('repeated_page');
  });
});

describe('Частичный обход', () => {
  it('сбой источника даёт incomplete, но сохраняет собранное', async () => {
    const source = new StubSource(
      [page([userReview('u1'), userReview('u2')], 100)],
      1, // падает на втором запросе
    );

    const result = await fetchAllReviews(deps(source), params);

    expect(result.reviews).toHaveLength(2);
    expect(result.stopReason).toBe('source_error');
    // Ключевое требование: частичный набор НЕ помечается complete
    expect(result.completeness).toBe('incomplete');
  });

  it('некорректные записи дают incomplete', async () => {
    const source = new StubSource([page([userReview('u1')], 1, 3)]);

    const result = await fetchAllReviews(deps(source), params);

    expect(result.malformed).toBe(3);
    expect(result.completeness).toBe('incomplete');
  });

  it('блокировка источника пробрасывается вызывающему', async () => {
    const source: ReviewSource = {
      fetchReviewPage: vi.fn(async () => {
        throw new IngestionError('blocked', 'Доступ запрещён', { status: 403 });
      }),
    };

    await expect(fetchAllReviews(deps(source), params)).rejects.toMatchObject({
      category: 'blocked',
    });
  });

  it('отмена операции даёт incomplete', async () => {
    const controller = new AbortController();
    controller.abort();

    const source = new StubSource([page([userReview('u1')], 100)]);
    const result = await fetchAllReviews(deps(source), {
      ...params,
      signal: controller.signal,
    });

    expect(result.completeness).toBe('incomplete');
  });
});

describe('resolveCompleteness', () => {
  const base = {
    stopReason: 'all_fetched' as const,
    sourceFailed: false,
    malformed: 0,
    collected: 10,
    totalAvailable: 10,
  };

  it('полный набор', () => {
    expect(resolveCompleteness(base)).toBe('complete');
  });

  it('сбой источника → incomplete', () => {
    expect(resolveCompleteness({ ...base, sourceFailed: true })).toBe('incomplete');
  });

  it('некорректные записи → incomplete', () => {
    expect(resolveCompleteness({ ...base, malformed: 1 })).toBe('incomplete');
  });

  it('предел страниц → incomplete', () => {
    expect(resolveCompleteness({ ...base, stopReason: 'page_limit' })).toBe('incomplete');
  });

  it('ограничение количеством → partial', () => {
    expect(resolveCompleteness({ ...base, stopReason: 'limit_reached' })).toBe('partial');
  });

  it('собрано меньше объявленного → partial', () => {
    expect(resolveCompleteness({ ...base, collected: 5, totalAvailable: 100 })).toBe(
      'partial',
    );
  });

  it('пустой набор при нулевом total → complete', () => {
    expect(resolveCompleteness({ ...base, collected: 0, totalAvailable: 0 })).toBe(
      'complete',
    );
  });
});

describe('Платформа в запросе', () => {
  it('передаётся источнику и попадает в результат', async () => {
    const source = new StubSource([page([userReview('u1')], 1)]);

    const result = await fetchAllReviews(deps(source), {
      ...params,
      platform: 'nintendo-switch',
    });

    expect(source.calls[0]!.platform).toBe('nintendo-switch');
    expect(result.platformSlug).toBe('nintendo-switch');
  });

  it('без платформы используется значение по умолчанию', async () => {
    const source = new StubSource([page([userReview('u1')], 1)]);

    const result = await fetchAllReviews(deps(source), {
      sourceSlug: 'game',
      kind: 'user',
    });

    expect(result.platformSlug).toBe('default');
  });
});
