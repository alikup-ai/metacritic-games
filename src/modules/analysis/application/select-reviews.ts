import type { ReviewKind, StoredReview } from '../../reviews/domain/review.js';
import { reviewKey } from '../../reviews/domain/review.js';
import type { PreparedReview } from '../domain/llm-provider.js';

/**
 * Детерминированный отбор отзывов для анализа.
 *
 * Случайность запрещена: тот же снимок обязан давать тот же вход, иначе
 * ключ идемпотентности менялся бы на каждом обходе и кеш не работал бы.
 *
 * Основания измерены на живых данных (ADR-0013):
 *   критики      — 93 отзыва = 35 690 символов, помещаются целиком;
 *   пользователи — p90 = 723, но максимум 4 941 символа;
 *   оценки перекошены: 131 «десятка» из 200, ≤3 балла лишь у 16.
 *
 * Из последнего следует стратификация: пропорциональная квота дала бы
 * негативной группе 2–3 позиции из 60, и раздел «что не нравится» опирался
 * бы на почти случайные записи при 1170 реальных негативных отзывах.
 */

export interface SelectionLimits {
  readonly maxReviews: number;
  readonly maxReviewChars: number;
  /** Приблизительный предел по символам всего входа. */
  readonly maxInputChars: number;
}

export type ReviewCoverage = 'all_reviews' | 'sample';

export interface SelectionResult {
  readonly reviews: readonly PreparedReview[];
  readonly coverage: ReviewCoverage;
  readonly analyzedCount: number;
  /** Отзывы, схлопнутые как дубликаты. */
  readonly deduplicated: number;
  readonly truncatedCount: number;
}

/** Доля бюджета, гарантированная каждой непустой группе тональности. */
const MIN_GROUP_SHARE = 0.2;

/**
 * Границы тональности.
 * Шкалы разные: критики 0–100, пользователи 0–10 (ADR-0012).
 */
function sentimentOf(review: StoredReview, kind: ReviewKind): 'negative' | 'neutral' | 'positive' {
  const score = review.score;
  // Отзыв без оценки не относим к негативу: отсутствие оценки не является
  // отрицательным мнением.
  if (score === null) return 'neutral';

  if (kind === 'critic') {
    if (score <= 49) return 'negative';
    if (score <= 74) return 'neutral';
    return 'positive';
  }

  if (score <= 3) return 'negative';
  if (score <= 6) return 'neutral';
  return 'positive';
}

/** Нормализация текста для поиска дубликатов. */
function normalizeForDedup(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Обрезает текст, не разрывая суррогатные пары и составные графемы.
 *
 * Обычный slice по code units разрывает эмодзи и символы вне BMP, оставляя
 * невалидный UTF-16, который затем портит JSON. Поэтому режем по кодовым
 * точкам через Intl.Segmenter, а при его отсутствии — по массиву символов.
 */
export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };

  // Segmenter учитывает графемные кластеры: эмодзи с модификаторами,
  // комбинирующие диакритики.
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    let result = '';
    for (const { segment } of segmenter.segment(text)) {
      if (result.length + segment.length > maxChars) break;
      result += segment;
    }
    return { text: result, truncated: true };
  }

  // Запасной путь: итерация по кодовым точкам не разрывает суррогатные пары.
  const points = [...text];
  let result = '';
  for (const point of points) {
    if (result.length + point.length > maxChars) break;
    result += point;
  }
  return { text: result, truncated: true };
}

/**
 * Полный порядок сортировки внутри группы.
 *
 * Ключ отзыва замыкает сравнение: без него отзывы с одинаковой оценкой и
 * датой шли бы в порядке выдачи БД, и отбор перестал бы быть
 * детерминированным.
 */
function compareReviews(a: StoredReview, b: StoredReview): number {
  const scoreA = a.score ?? -1;
  const scoreB = b.score ?? -1;
  if (scoreA !== scoreB) return scoreB - scoreA;

  const dateA = a.reviewDate ?? '';
  const dateB = b.reviewDate ?? '';
  if (dateA !== dateB) return dateA < dateB ? 1 : -1;

  return reviewKey(a.identity) < reviewKey(b.identity) ? -1 : 1;
}

/**
 * Распределяет бюджет между группами.
 *
 * Каждая НЕПУСТАЯ группа получает не менее MIN_GROUP_SHARE бюджета.
 * Пустые группы не добираются искусственно: если негатива нет, выдумывать
 * его нельзя — это исказило бы картину.
 */
export function allocateQuotas(
  groupSizes: Record<string, number>,
  budget: number,
): Record<string, number> {
  const nonEmpty = Object.entries(groupSizes).filter(([, size]) => size > 0);
  if (nonEmpty.length === 0) return {};

  const total = nonEmpty.reduce((sum, [, size]) => sum + size, 0);
  const minQuota = Math.max(1, Math.floor(budget * MIN_GROUP_SHARE));

  const quotas: Record<string, number> = {};
  let assigned = 0;

  for (const [name, size] of nonEmpty) {
    // Квота не может превышать реальный размер группы.
    const proportional = Math.floor((size / total) * budget);
    const quota = Math.min(size, Math.max(proportional, minQuota));
    quotas[name] = quota;
    assigned += quota;
  }

  // Перераспределение: остаток отдаётся группам, где ещё есть записи;
  // избыток срезается с самых больших квот.
  let remaining = budget - assigned;

  while (remaining > 0) {
    const candidates = nonEmpty.filter(([name, size]) => (quotas[name] ?? 0) < size);
    if (candidates.length === 0) break;
    for (const [name, size] of candidates) {
      if (remaining <= 0) break;
      if ((quotas[name] ?? 0) < size) {
        quotas[name] = (quotas[name] ?? 0) + 1;
        remaining -= 1;
      }
    }
  }

  while (remaining < 0) {
    const sorted = Object.entries(quotas).sort((a, b) => b[1] - a[1]);
    const largest = sorted[0];
    if (!largest || largest[1] <= 1) break;
    quotas[largest[0]] = largest[1] - 1;
    remaining += 1;
  }

  return quotas;
}

export function selectReviewsForAnalysis(
  reviews: readonly StoredReview[],
  kind: ReviewKind,
  limits: SelectionLimits,
): SelectionResult {
  // Шаг 1: дедупликация по нормализованному тексту. Защищает от накрутки
  // одинаковыми отзывами и экономит бюджет.
  const byText = new Map<string, { review: StoredReview; count: number }>();
  for (const review of [...reviews].sort(compareReviews)) {
    const key = normalizeForDedup(review.quote);
    const existing = byText.get(key);
    if (existing) existing.count += 1;
    else byText.set(key, { review, count: 1 });
  }

  const unique = [...byText.values()];
  const deduplicated = reviews.length - unique.length;

  // Шаг 2: если набор помещается — берём целиком.
  let chosen: { review: StoredReview; count: number }[];
  let coverage: ReviewCoverage;

  if (unique.length <= limits.maxReviews) {
    chosen = unique;
    coverage = 'all_reviews';
  } else {
    // Шаг 3: стратификация по тональности.
    const groups: Record<string, { review: StoredReview; count: number }[]> = {
      negative: [],
      neutral: [],
      positive: [],
    };

    for (const entry of unique) {
      groups[sentimentOf(entry.review, kind)]!.push(entry);
    }

    const sizes = Object.fromEntries(
      Object.entries(groups).map(([name, items]) => [name, items.length]),
    );
    const quotas = allocateQuotas(sizes, limits.maxReviews);

    chosen = [];
    for (const [name, items] of Object.entries(groups)) {
      const quota = quotas[name] ?? 0;
      // Внутри группы порядок уже задан общей сортировкой выше.
      chosen.push(...items.slice(0, quota));
    }

    coverage = 'sample';
  }

  // Шаг 4: подготовка с обрезом. Сортировка повторяется, чтобы метки ref
  // назначались в стабильном порядке независимо от порядка групп.
  chosen.sort((a, b) => compareReviews(a.review, b.review));

  const prepared: PreparedReview[] = [];
  let truncatedCount = 0;
  let usedChars = 0;

  for (const [index, entry] of chosen.entries()) {
    const { text, truncated } = truncateText(entry.review.quote, limits.maxReviewChars);

    // Общий предел по символам — второй предохранитель поверх лимита
    // на количество.
    if (usedChars + text.length > limits.maxInputChars && prepared.length > 0) break;

    usedChars += text.length;
    if (truncated) truncatedCount += 1;

    prepared.push({
      ref: `r${index + 1}`,
      reviewKey: reviewKey(entry.review.identity),
      score: entry.review.score,
      date: entry.review.reviewDate,
      text,
      truncated,
      duplicates: entry.count,
      source: entry.review.identity.kind === 'critic' ? 'critic' : 'user',
    });
  }

  return {
    reviews: prepared,
    // Если общий предел по символам обрезал набор, покрытие уже неполное.
    coverage: prepared.length < unique.length ? 'sample' : coverage,
    analyzedCount: prepared.length,
    deduplicated,
    truncatedCount,
  };
}
