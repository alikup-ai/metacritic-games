import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  normalizePlatformSlug,
  parseCriticReviewPage,
  parseReviewPage,
  parseUserReviewPage,
} from '../../src/modules/reviews/infrastructure/parsers/review-parser.js';
import { ParseError } from '../../src/modules/ingestion/domain/ingestion-errors.js';
import {
  fingerprintParts,
  reviewKey,
} from '../../src/modules/reviews/domain/review.js';

/** Тесты на фикстурах: сеть не используется. */

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'metacritic',
);

const load = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

const opts = { url: 'https://example.test/api', platformSlug: 'pc' };

describe('Парсер пользовательских отзывов', () => {
  const payload = load('reviews-api-user-many');

  it('извлекает отзывы с внешним id', () => {
    const page = parseUserReviewPage(payload, opts);

    expect(page.kind).toBe('user');
    expect(page.reviews.length).toBeGreaterThan(0);
    expect(page.reviews[0]!.identity).toMatchObject({ kind: 'user' });
  });

  it('идентичность строится на id, а не на тексте', () => {
    const page = parseUserReviewPage(payload, opts);
    for (const review of page.reviews) {
      expect(review.identity.kind).toBe('user');
      if (review.identity.kind === 'user') {
        expect(review.identity.externalId).toMatch(/^[0-9a-f-]{36}$/);
      }
    }
  });

  it('извлекает totalAvailable из ответа источника', () => {
    const page = parseUserReviewPage(payload, opts);
    expect(page.totalAvailable).toBe(6595);
  });

  it('оценка пользователя в шкале 0–10', () => {
    const page = parseUserReviewPage(payload, opts);
    for (const review of page.reviews) {
      if (review.score !== null) {
        expect(review.score).toBeGreaterThanOrEqual(0);
        expect(review.score).toBeLessThanOrEqual(10);
      }
    }
  });

  it('дата нормализуется в ISO', () => {
    const page = parseUserReviewPage(payload, opts);
    for (const review of page.reviews) {
      if (review.reviewDate !== null) {
        expect(review.reviewDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it('сохраняет version источника', () => {
    const page = parseUserReviewPage(payload, opts);
    expect(page.reviews[0]!.sourceVersion).toBeTypeOf('number');
  });

  it('reviewUrl всегда null: источник не публикует ссылок', () => {
    const page = parseUserReviewPage(payload, opts);
    for (const review of page.reviews) {
      expect(review.reviewUrl).toBeNull();
    }
  });

  it('платформа берётся из параметра запроса', () => {
    const page = parseUserReviewPage(payload, { ...opts, platformSlug: 'switch' });
    for (const review of page.reviews) {
      expect(review.platformSlug).toBe('switch');
    }
  });
});

describe('Парсер критических отзывов', () => {
  const payload = load('reviews-api-critic-many');

  it('идентичность строится на слаге издания', () => {
    const page = parseCriticReviewPage(payload, opts);

    expect(page.kind).toBe('critic');
    expect(page.reviews.length).toBeGreaterThan(0);
    for (const review of page.reviews) {
      expect(review.identity.kind).toBe('critic');
      if (review.identity.kind === 'critic') {
        expect(review.identity.publicationSlug.length).toBeGreaterThan(0);
      }
    }
  });

  it('оценка критика в шкале 0–100', () => {
    const page = parseCriticReviewPage(payload, opts);
    for (const review of page.reviews) {
      if (review.score !== null) {
        expect(review.score).toBeGreaterThanOrEqual(0);
        expect(review.score).toBeLessThanOrEqual(100);
        expect(Number.isInteger(review.score)).toBe(true);
      }
    }
  });

  it('sourceVersion отсутствует у критических отзывов', () => {
    const page = parseCriticReviewPage(payload, opts);
    for (const review of page.reviews) {
      expect(review.sourceVersion).toBeNull();
    }
  });

  it('отзыв без url не теряется', () => {
    const withoutUrl = {
      data: {
        totalResults: 1,
        items: [{ publicationSlug: 'pub', quote: 'Текст рецензии', score: 80 }],
      },
    };

    const page = parseCriticReviewPage(withoutUrl, opts);
    expect(page.reviews).toHaveLength(1);
    expect(page.reviews[0]!.reviewUrl).toBeNull();
  });

  it('при отсутствии автора используется название издания', () => {
    const payload2 = {
      data: {
        totalResults: 1,
        items: [
          {
            publicationSlug: 'ign',
            publicationName: 'IGN',
            quote: 'Текст',
            score: 90,
            author: null,
          },
        ],
      },
    };

    const page = parseCriticReviewPage(payload2, opts);
    expect(page.reviews[0]!.author).toBe('IGN');
  });
});

describe('Нормализация значений', () => {
  it('отзыв без оценки даёт null, а не 0', () => {
    const payload = {
      data: { totalResults: 1, items: [{ publicationSlug: 'p', quote: 'Q', score: null }] },
    };
    const page = parseCriticReviewPage(payload, opts);

    expect(page.reviews[0]!.score).toBeNull();
    expect(page.reviews[0]!.score).not.toBe(0);
  });

  it('оценка вне шкалы отбрасывается', () => {
    const payload = {
      data: { totalResults: 1, items: [{ publicationSlug: 'p', quote: 'Q', score: 500 }] },
    };
    expect(parseCriticReviewPage(payload, opts).reviews[0]!.score).toBeNull();
  });

  it('оценка пользователя выше 10 отбрасывается', () => {
    const payload = {
      data: { totalResults: 1, items: [{ id: 'u1', quote: 'Q', score: 55 }] },
    };
    expect(parseUserReviewPage(payload, opts).reviews[0]!.score).toBeNull();
  });

  it('текст отзыва сохраняет переносы строк', () => {
    const payload = {
      data: { totalResults: 1, items: [{ id: 'u1', quote: 'Первая\nВторая', score: 8 }] },
    };
    expect(parseUserReviewPage(payload, opts).reviews[0]!.quote).toContain('\n');
  });

  it('относительный url отбрасывается', () => {
    const payload = {
      data: {
        totalResults: 1,
        items: [{ publicationSlug: 'p', quote: 'Q', url: '/relative/path' }],
      },
    };
    expect(parseCriticReviewPage(payload, opts).reviews[0]!.reviewUrl).toBeNull();
  });

  it('нормализует слаг платформы', () => {
    expect(normalizePlatformSlug('PlayStation 5')).toBe('playstation-5');
    expect(normalizePlatformSlug('Xbox Series X')).toBe('xbox-series-x');
    expect(normalizePlatformSlug('  ')).toBeNull();
  });
});

describe('Некорректные записи', () => {
  it('запись без id не превращается в валидный пустой отзыв', () => {
    const payload = {
      data: {
        totalResults: 2,
        items: [
          { quote: 'Без id', score: 8 },
          { id: 'u1', quote: 'С id', score: 9 },
        ],
      },
    };

    const page = parseUserReviewPage(payload, opts);
    expect(page.reviews).toHaveLength(1);
    expect(page.malformed).toBe(1);
  });

  it('запись без слага издания считается некорректной', () => {
    const payload = {
      data: {
        totalResults: 2,
        items: [
          { quote: 'Без издания', score: 80 },
          { publicationSlug: 'ok', quote: 'С изданием', score: 85 },
        ],
      },
    };

    const page = parseCriticReviewPage(payload, opts);
    expect(page.reviews).toHaveLength(1);
    expect(page.malformed).toBe(1);
  });

  it('запись без текста считается некорректной', () => {
    const payload = {
      data: { totalResults: 1, items: [{ id: 'u1', quote: '   ', score: 8 }] },
    };

    const page = parseUserReviewPage(payload, opts);
    expect(page.reviews).toHaveLength(0);
    expect(page.malformed).toBe(1);
  });

  it('не-объект в массиве считается некорректной записью', () => {
    const payload = { data: { totalResults: 2, items: ['строка', null] } };

    const page = parseUserReviewPage(payload, opts);
    expect(page.reviews).toHaveLength(0);
    expect(page.malformed).toBe(2);
  });

  it('отсутствие блока data — ошибка, а не пустой набор', () => {
    expect(() => parseUserReviewPage({}, opts)).toThrow(ParseError);
    expect(() => parseCriticReviewPage({ other: 1 }, opts)).toThrow(ParseError);
  });

  it('items не массив — ошибка', () => {
    expect(() => parseUserReviewPage({ data: { items: 'нет' } }, opts)).toThrow(ParseError);
  });

  it('пустой items — валидный пустой набор, не ошибка', () => {
    const page = parseUserReviewPage({ data: { totalResults: 0, items: [] } }, opts);
    expect(page.reviews).toHaveLength(0);
    expect(page.malformed).toBe(0);
    expect(page.totalAvailable).toBe(0);
  });
});

describe('Фикстуры источника', () => {
  it('фикстура «ноль отзывов» даёт пустой валидный результат', () => {
    const page = parseUserReviewPage(load('reviews-api-user-empty'), opts);
    expect(page.reviews).toHaveLength(0);
    expect(page.totalAvailable).toBe(0);
  });

  it('фикстура с малым числом критических отзывов разбирается', () => {
    const page = parseCriticReviewPage(load('reviews-api-critic-few'), opts);
    expect(page.reviews.length).toBeGreaterThan(0);
    expect(page.totalAvailable).toBe(9);
  });

  it('платформенная фикстура разбирается', () => {
    const page = parseCriticReviewPage(load('reviews-api-critic-platform-pc'), {
      ...opts,
      platformSlug: 'pc',
    });
    expect(page.totalAvailable).toBe(33);
    expect(page.reviews.every((r) => r.platformSlug === 'pc')).toBe(true);
  });

  it('все фикстуры разбираются без исключений', () => {
    const files = [
      ['reviews-api-critic-many', 'critic'],
      ['reviews-api-critic-few', 'critic'],
      ['reviews-api-critic-platform-pc', 'critic'],
      ['reviews-api-user-many', 'user'],
      ['reviews-api-user-empty', 'user'],
      ['reviews-api-user-page2', 'user'],
      ['reviews-api-user-platform-switch', 'user'],
    ] as const;

    for (const [file, kind] of files) {
      expect(() => parseReviewPage(kind, load(file), opts)).not.toThrow();
    }
  });
});

describe('Отпечаток набора', () => {
  const review = (id: string, score: number | null) => ({
    identity: { kind: 'user' as const, externalId: id },
    platformSlug: 'pc',
    score,
    quote: 'Q',
    author: null,
    reviewUrl: null,
    reviewDate: null,
    sourceVersion: null,
    spoiler: null,
  });

  it('не зависит от порядка элементов', () => {
    const a = fingerprintParts([review('u1', 8), review('u2', 9)]);
    const b = fingerprintParts([review('u2', 9), review('u1', 8)]);
    expect(a).toBe(b);
  });

  it('меняется при изменении оценки', () => {
    const a = fingerprintParts([review('u1', 8)]);
    const b = fingerprintParts([review('u1', 9)]);
    expect(a).not.toBe(b);
  });

  it('меняется при добавлении отзыва', () => {
    const a = fingerprintParts([review('u1', 8)]);
    const b = fingerprintParts([review('u1', 8), review('u2', 7)]);
    expect(a).not.toBe(b);
  });

  it('ключи критиков и пользователей не пересекаются', () => {
    const userKey = reviewKey({ kind: 'user', externalId: 'ign' });
    const criticKey = reviewKey({ kind: 'critic', publicationSlug: 'ign' });
    expect(userKey).not.toBe(criticKey);
  });
});
