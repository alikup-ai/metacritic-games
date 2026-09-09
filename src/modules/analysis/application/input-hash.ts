import type { ReviewKind } from '../../reviews/domain/review.js';
import type { PreparedReview } from '../domain/llm-provider.js';

/**
 * Канонический вход анализа и его отпечаток.
 *
 * Отпечаток отвечает на вопрос «нужно ли снова платить за вызов модели».
 * Он обязан меняться при изменении любого фактора, влияющего на результат,
 * и НЕ меняться, если не изменилось ничего.
 *
 * Времени в отпечатке нет: иначе каждый обход давал бы новый хеш и кеш
 * никогда бы не срабатывал.
 */

export interface InputHashParts {
  readonly kind: ReviewKind;
  readonly platformSlug: string;
  readonly reviews: readonly PreparedReview[];
  readonly promptVersion: string;
  readonly samplingVersion: string;
  readonly model: string;
}

/**
 * Строит каноническое представление входа.
 *
 * Отзывы сортируются по ключу, а не по метке ref: метка зависит от позиции
 * в выборке, и при том же наборе, но иной сортировке, давала бы другой хеш.
 *
 * В отпечаток входит и содержимое (score + текст): правка текста отзыва
 * обязана вызывать переанализ, иначе резюме останется описывать прошлую
 * редакцию.
 */
export function canonicalizeInput(parts: InputHashParts): string {
  const reviewLines = parts.reviews
    .map((review) =>
      [
        review.reviewKey,
        review.score ?? '',
        review.truncated ? 't' : 'f',
        review.text,
      ].join(''),
    )
    .sort();

  return [
    `kind=${parts.kind}`,
    `platform=${parts.platformSlug}`,
    `prompt=${parts.promptVersion}`,
    `sampling=${parts.samplingVersion}`,
    `model=${parts.model}`,
    `count=${parts.reviews.length}`,
    ...reviewLines,
  ].join('');
}

/**
 * Вычисляет отпечаток входа.
 *
 * Хеширование передаётся снаружи: application не зависит от
 * криптографического модуля платформы.
 */
export function computeInputHash(
  parts: InputHashParts,
  hash: (input: string) => string,
): string {
  return hash(canonicalizeInput(parts));
}
