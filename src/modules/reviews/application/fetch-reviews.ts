import { isIngestionError } from '../../ingestion/domain/ingestion-errors.js';
import {
  fingerprintParts,
  reviewKey,
  type NormalizedReview,
  type ReviewFetchResult,
  type ReviewKind,
  type ReviewStopReason,
  type SnapshotCompleteness,
} from '../domain/review.js';
import type { ReviewSource } from '../domain/review-ports.js';

/**
 * Постраничный обход отзывов одного типа.
 *
 * Защита от зацикливания повторяет подход каталога (ADR-0002): отпечаток
 * набора ключей, а не номер страницы — источник может отдавать одинаковое
 * содержимое под разными смещениями.
 *
 * Ключевое свойство: частичный обход НИКОГДА не помечается complete
 * (ADR-0012). Иначе исчезнувшие отзывы были бы удалены по неполным данным.
 */

export interface FetchReviewsDeps {
  readonly source: ReviewSource;
  readonly maxPages: number;
  readonly pageSize: number;
  /** Верхний предел числа отзывов; 0 означает «без ограничения». */
  readonly maxReviews: number;
}

export interface FetchReviewsParams {
  readonly sourceSlug: string;
  readonly kind: ReviewKind;
  readonly platform?: string;
  readonly signal?: AbortSignal;
}

export async function fetchAllReviews(
  deps: FetchReviewsDeps,
  params: FetchReviewsParams,
): Promise<ReviewFetchResult> {
  const platformSlug = params.platform ?? 'default';

  const collected: NormalizedReview[] = [];
  const seenKeys = new Set<string>();
  const seenPageSignatures = new Set<string>();

  let offset = 0;
  let pagesScanned = 0;
  let malformed = 0;
  let totalAvailable = 0;
  let stopReason: ReviewStopReason = 'all_fetched';
  let sourceFailed = false;

  for (;;) {
    if (params.signal?.aborted) {
      stopReason = 'source_error';
      sourceFailed = true;
      break;
    }

    if (pagesScanned >= deps.maxPages) {
      stopReason = 'page_limit';
      break;
    }

    let page;
    try {
      page = await deps.source.fetchReviewPage({
        sourceSlug: params.sourceSlug,
        kind: params.kind,
        ...(params.platform ? { platform: params.platform } : {}),
        offset,
        limit: deps.pageSize,
        ...(params.signal ? { signal: params.signal } : {}),
      });
    } catch (error) {
      // Блокировка источника должна дойти до вызывающего: продолжать
      // обход нельзя, и это не «частичный результат», а прекращение.
      if (isIngestionError(error) && error.category === 'blocked') throw error;

      // Прочие ошибки обрывают обход, но уже собранное сохраняется —
      // с пометкой incomplete.
      stopReason = 'source_error';
      sourceFailed = true;
      break;
    }

    pagesScanned += 1;
    malformed += page.malformed;
    totalAvailable = Math.max(totalAvailable, page.totalAvailable);

    // Пустая страница означает конец выборки.
    if (page.reviews.length === 0) {
      stopReason = pagesScanned === 1 ? 'all_fetched' : 'empty_page';
      break;
    }

    // Отпечаток НАБОРА КЛЮЧЕЙ: защищает от источника, отдающего одно и то
    // же содержимое под разными offset.
    const signature = page.reviews
      .map((review) => reviewKey(review.identity))
      .sort()
      .join(',');

    if (seenPageSignatures.has(signature)) {
      stopReason = 'repeated_page';
      break;
    }
    seenPageSignatures.add(signature);

    // Дубликаты между страницами отбрасываются: при добавлении новых
    // отзывов во время обхода записи сдвигаются и могут повториться.
    let addedFromPage = 0;
    for (const review of page.reviews) {
      const key = reviewKey(review.identity);
      if (seenKeys.has(key)) continue;

      seenKeys.add(key);
      collected.push(review);
      addedFromPage += 1;

      if (deps.maxReviews > 0 && collected.length >= deps.maxReviews) break;
    }

    if (deps.maxReviews > 0 && collected.length >= deps.maxReviews) {
      stopReason = 'limit_reached';
      break;
    }

    // Страница целиком состояла из уже виденных отзывов — источник
    // повторяется, дальше идти бессмысленно.
    if (addedFromPage === 0) {
      stopReason = 'repeated_page';
      break;
    }

    if (totalAvailable > 0 && collected.length >= totalAvailable) {
      stopReason = 'all_fetched';
      break;
    }

    offset += deps.pageSize;
  }

  return {
    kind: params.kind,
    platformSlug,
    reviews: collected,
    totalAvailable,
    completeness: resolveCompleteness({
      stopReason,
      sourceFailed,
      malformed,
      collected: collected.length,
      totalAvailable,
    }),
    malformed,
    pagesScanned,
    stopReason,
  };
}

/**
 * Определяет полноту набора.
 *
 * Правило ADR-0012: частичный набор никогда не помечается complete.
 * Различаются три состояния, потому что реакция на них разная:
 *   complete   — можно удалять исчезнувшие отзывы;
 *   partial    — штатное ограничение лимитом, удалять нельзя;
 *   incomplete — деградация, удалять нельзя и нужен повторный обход.
 */
export function resolveCompleteness(input: {
  stopReason: ReviewStopReason;
  sourceFailed: boolean;
  malformed: number;
  collected: number;
  totalAvailable: number;
}): SnapshotCompleteness {
  // Сбой источника или нераспознанные записи — деградация.
  if (input.sourceFailed || input.stopReason === 'source_error') return 'incomplete';
  if (input.malformed > 0) return 'incomplete';

  // Упёрлись в защитный предел страниц — набор заведомо неполон.
  if (input.stopReason === 'page_limit') return 'incomplete';

  // Сознательное ограничение количеством — штатный режим.
  if (input.stopReason === 'limit_reached') return 'partial';

  // Источник повторился: часть отзывов могла остаться недостижимой.
  if (input.stopReason === 'repeated_page') return 'incomplete';

  // Собрали меньше, чем объявил источник, без явной причины.
  if (input.totalAvailable > 0 && input.collected < input.totalAvailable) {
    return 'partial';
  }

  return 'complete';
}

/** Отпечаток набора — вход для сравнения снимков. */
export function computeFingerprintInput(reviews: readonly NormalizedReview[]): string {
  return fingerprintParts(reviews);
}
