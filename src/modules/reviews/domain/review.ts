/**
 * Доменная модель отзывов (ADR-0012).
 *
 * Слой не зависит от инфраструктуры: ни HTTP, ни SQL, ни формата источника.
 */

export type ReviewKind = 'critic' | 'user';

/**
 * Ключ отзыва в источнике.
 *
 * Форма различается по типу, потому что источник даёт разное:
 * - пользовательские отзывы имеют стабильный UUID;
 * - у критических id ОТСУТСТВУЕТ, ключом служит слаг издания.
 */
export type ReviewIdentity =
  | { readonly kind: 'user'; readonly externalId: string }
  | { readonly kind: 'critic'; readonly publicationSlug: string };

/**
 * Полнота набора отзывов.
 *
 * Три состояния вместо булева признака, потому что «ограничено лимитом» и
 * «обход сорвался» требуют разной реакции: при complete исчезнувшие отзывы
 * удаляются, при остальных — нет.
 */
export type SnapshotCompleteness = 'complete' | 'partial' | 'incomplete';

/** Нормализованный отзыв: без следов формата источника. */
export interface NormalizedReview {
  readonly identity: ReviewIdentity;
  readonly platformSlug: string;
  /** critic: 0–100, user: 0–10. null допустим — встречен отзыв без оценки. */
  readonly score: number | null;
  readonly quote: string;
  readonly author: string | null;
  /** critic: может отсутствовать; user: источник не публикует. */
  readonly reviewUrl: string | null;
  /** ISO YYYY-MM-DD. */
  readonly reviewDate: string | null;
  /** user: поле version источника; critic: отсутствует. */
  readonly sourceVersion: number | null;
  readonly spoiler: boolean | null;
}

/** Страница отзывов, полученная из источника. */
export interface NormalizedReviewPage {
  readonly kind: ReviewKind;
  readonly platformSlug: string;
  readonly reviews: readonly NormalizedReview[];
  /** totalResults источника — база для вычисления полноты. */
  readonly totalAvailable: number;
  /** Записи, которые не удалось разобрать. */
  readonly malformed: number;
}

/** Итоговый набор отзывов после обхода всех страниц. */
export interface ReviewFetchResult {
  readonly kind: ReviewKind;
  readonly platformSlug: string;
  readonly reviews: readonly NormalizedReview[];
  readonly totalAvailable: number;
  readonly completeness: SnapshotCompleteness;
  readonly malformed: number;
  readonly pagesScanned: number;
  readonly stopReason: ReviewStopReason;
}

export type ReviewStopReason =
  | 'all_fetched'
  | 'limit_reached'
  | 'page_limit'
  | 'repeated_page'
  | 'empty_page'
  | 'source_error';

/** Метаданные снимка набора отзывов. */
export interface ReviewSnapshot {
  readonly gameId: string;
  readonly kind: ReviewKind;
  readonly platformSlug: string;
  readonly fingerprint: string;
  readonly reviewCount: number;
  readonly totalAvailable: number | null;
  readonly completeness: SnapshotCompleteness;
  readonly malformedCount: number;
  readonly fetchedAt: Date;
}

/** Отзыв, сохранённый в каталоге. */
export interface StoredReview extends NormalizedReview {
  readonly id: string;
  readonly gameId: string;
  readonly contentHash: string;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

/** Строковый ключ отзыва — для сравнения множеств и вычисления fingerprint. */
export function reviewKey(identity: ReviewIdentity): string {
  return identity.kind === 'user'
    ? `user:${identity.externalId}`
    : `critic:${identity.publicationSlug}`;
}

/**
 * Хеш значимого содержимого отзыва.
 *
 * Меняется при правке текста, оценки, автора или даты — то есть при том, что
 * влияет на смысл. Служебные поля источника в расчёт не входят: иначе
 * пересчёт резюме запускался бы на каждом обходе.
 *
 * Реализация хеша передаётся снаружи, чтобы доменный слой не зависел от
 * криптографического модуля платформы.
 */
export function reviewContentParts(review: NormalizedReview): string {
  return [
    reviewKey(review.identity),
    review.score ?? '',
    review.quote,
    review.author ?? '',
    review.reviewDate ?? '',
  ].join('');
}

/**
 * Вычисляет отпечаток набора отзывов.
 *
 * Считается по ОТСОРТИРОВАННОМУ множеству ключей и оценок, а не по сырому
 * ответу: порядок элементов и служебные поля меняются между запросами, и
 * отпечаток ответа давал бы ложное «изменилось» на каждом обходе, обнуляя
 * экономию вызовов LLM.
 */
export function fingerprintParts(reviews: readonly NormalizedReview[]): string {
  return reviews
    .map((review) => `${reviewKey(review.identity)}:${review.score ?? ''}`)
    .sort()
    .join('\n');
}

/**
 * Можно ли удалять отзывы, отсутствующие в новом наборе.
 *
 * Только при полном снимке: при частичном отсутствие отзыва означает, что он
 * не попал в выборку, а не что его удалили. Та же логика, что с пустым
 * снимком платформ (ADR-0011).
 */
export function canDeleteMissing(completeness: SnapshotCompleteness): boolean {
  return completeness === 'complete';
}
