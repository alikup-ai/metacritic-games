/**
 * Проверка внешних ссылок.
 *
 * Адреса приходят из внешнего источника и считаются недоверенными. Схема
 * javascript: в href выполняет код при переходе, поэтому пропускаются
 * только http и https.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Возвращает адрес, если он безопасен, иначе null.
 *
 * Разбор через URL, а не проверка префикса строки: «JaVaScRiPt:», пробелы
 * и управляющие символы в начале обошли бы наивное сравнение.
 */
export function safeExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    return ALLOWED_PROTOCOLS.has(parsed.protocol) ? parsed.toString() : null;
  } catch {
    // Относительные и некорректные адреса наружу не отдаём.
    return null;
  }
}

/**
 * Проверка адреса изображения.
 *
 * Отдельно от ссылок: для src допустимы те же схемы, но data: исключён
 * намеренно — он позволил бы встроить произвольное содержимое.
 */
export function safeImageUrl(url: string | null | undefined): string | null {
  return safeExternalUrl(url);
}
