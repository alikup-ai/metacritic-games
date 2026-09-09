/**
 * Разбор заголовка Retry-After.
 *
 * Живёт в shared, потому что нужен любому клиенту внешнего API, а не
 * только адаптеру Metacritic: заголовок стандартный (RFC 9110).
 */

/**
 * Разбирает Retry-After: поддерживаются оба формата — секунды и HTTP-дата.
 *
 * Возвращает задержку в миллисекундах либо undefined, если заголовка нет
 * или он не разбирается.
 */
export function parseRetryAfter(
  headerValue: string | null,
  now: () => number = Date.now,
): number | undefined {
  if (!headerValue) return undefined;

  const trimmed = headerValue.trim();

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - now();
    return delta > 0 ? delta : 0;
  }

  return undefined;
}
