/**
 * Разбор и проверка входных параметров.
 *
 * Всё, что приходит от клиента, проверяется до обращения к приложению.
 * Значения перечислений берутся из белых списков: имя колонки или
 * произвольное выражение от клиента в запрос попасть не может.
 */

import { ApiError } from './errors.js';

/** Разрешённые поля сортировки. Соответствуют GameSortField в домене. */
export const SORT_FIELDS = ['metascore', 'userscore', 'releaseDate', 'title'] as const;
export type SortField = (typeof SORT_FIELDS)[number];

export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

export const REVIEW_KINDS = ['critic', 'user'] as const;
export type ReviewKindParam = (typeof REVIEW_KINDS)[number];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Slug платформы: только буквы, цифры и дефис.
 *
 * Значение уходит в запрос параметром, так что инъекция невозможна и без
 * этой проверки. Ограничение нужно по другой причине: оно отсекает явный
 * мусор до похода в базу.
 */
const SLUG_PATTERN = /^[a-z0-9-]{1,64}$/i;

const MAX_SEARCH_LENGTH = 100;

export function parseUuid(value: string | undefined, field: string): string {
  if (!value || !UUID_PATTERN.test(value)) {
    throw new ApiError('VALIDATION_ERROR', `Параметр ${field} должен быть UUID`, {
      details: { field },
    });
  }
  return value;
}

export function parseEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  field: string,
  fallback?: T,
): T {
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new ApiError('VALIDATION_ERROR', `Параметр ${field} обязателен`, {
      details: { field, allowed },
    });
  }

  if (!allowed.includes(value as T)) {
    // Недопустимое значение не подставляется в сообщение: оно управляется
    // клиентом и может содержать что угодно.
    throw new ApiError('VALIDATION_ERROR', `Недопустимое значение параметра ${field}`, {
      details: { field, allowed },
    });
  }

  return value as T;
}

export function parsePage(value: string | undefined): number {
  if (value === undefined || value === '') return 1;

  const page = Number(value);
  if (!Number.isInteger(page) || page < 1) {
    throw new ApiError('VALIDATION_ERROR', 'Параметр page должен быть целым числом ≥ 1', {
      details: { field: 'page' },
    });
  }

  return page;
}

/**
 * Размер страницы с жёстким верхним пределом.
 *
 * Предел обязателен: без него запрос с pageSize=100000 стал бы способом
 * нагрузить базу одним обращением.
 */
export function parsePageSize(
  value: string | undefined,
  defaults: { defaultSize: number; maxSize: number },
): number {
  if (value === undefined || value === '') return defaults.defaultSize;

  const size = Number(value);
  if (!Number.isInteger(size) || size < 1) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'Параметр pageSize должен быть целым числом ≥ 1',
      { details: { field: 'pageSize' } },
    );
  }

  if (size > defaults.maxSize) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `Параметр pageSize не может превышать ${defaults.maxSize}`,
      { details: { field: 'pageSize' } },
    );
  }

  return size;
}

/** Строка поиска: обрезается по длине, пустая считается отсутствующей. */
export function parseSearch(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  if (trimmed.length > MAX_SEARCH_LENGTH) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `Параметр q не может быть длиннее ${MAX_SEARCH_LENGTH} символов`,
      { details: { field: 'q' } },
    );
  }

  return trimmed;
}

export function parsePlatformSlug(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  if (!SLUG_PATTERN.test(trimmed)) {
    throw new ApiError('VALIDATION_ERROR', 'Недопустимое значение параметра platform', {
      details: { field: 'platform' },
    });
  }

  return trimmed.toLowerCase();
}

export function parseLimit(
  value: string | undefined,
  defaults: { defaultLimit: number; maxLimit: number },
): number {
  if (value === undefined || value === '') return defaults.defaultLimit;

  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ApiError('VALIDATION_ERROR', 'Параметр limit должен быть целым числом ≥ 1', {
      details: { field: 'limit' },
    });
  }

  return Math.min(limit, defaults.maxLimit);
}
