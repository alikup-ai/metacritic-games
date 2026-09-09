import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.js';

/**
 * Проверка админ-токена (ADR-0007).
 *
 * Коды ответа различаются намеренно: 401 — заголовка нет, 403 — токен
 * неверен. Это не ускоряет перебор, поскольку само сравнение выполняется
 * за постоянное время.
 *
 * Токен не логируется и не попадает в ответ ни при каком исходе.
 */

/**
 * Сравнение за постоянное время.
 *
 * Сравниваются хеши, а не сами строки: timingSafeEqual требует равной
 * длины, и передача строк разной длины сама по себе выдала бы длину
 * ожидаемого токена через исключение.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

export const ADMIN_TOKEN_HEADER = 'x-admin-token';

/**
 * Требует корректный админ-токен.
 *
 * Если токен не настроен на сервере, защищённая операция недоступна:
 * открытый endpoint был бы опаснее отключённого.
 */
export function requireAdminToken(params: {
  headerValue: string | undefined;
  expectedToken: string | undefined;
}): void {
  if (!params.expectedToken) {
    throw new ApiError(
      'SERVICE_UNAVAILABLE',
      'Ручной запуск недоступен: админ-токен не настроен на сервере',
    );
  }

  if (params.headerValue === undefined || params.headerValue === '') {
    throw new ApiError('UNAUTHORIZED', 'Требуется заголовок X-Admin-Token');
  }

  if (!constantTimeEquals(params.headerValue, params.expectedToken)) {
    // В сообщении нет ни присланного, ни ожидаемого значения.
    throw new ApiError('FORBIDDEN', 'Недействительный админ-токен');
  }
}
