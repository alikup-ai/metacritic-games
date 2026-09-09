/**
 * Единый формат ошибок API.
 *
 * Наружу уходят только стабильный код, безопасное сообщение и requestId.
 * Ни трассировки стека, ни текста ошибок SQL, ни сообщений внешних
 * провайдеров: они раскрывают устройство системы и могут содержать
 * фрагменты запросов.
 */

/** Стабильные коды ошибок. Клиент вправе на них полагаться. */
export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'GAME_NOT_FOUND'
  | 'RUN_NOT_FOUND'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  GAME_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export interface ApiErrorDetails {
  /** Поле, вызвавшее ошибку валидации. Значение сюда не подставляется. */
  readonly field?: string;
  readonly allowed?: readonly string[];
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: ApiErrorDetails | undefined;
  /** Задержка до следующей попытки; только для RATE_LIMITED. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ApiErrorCode,
    message: string,
    options?: { details?: ApiErrorDetails; retryAfterSeconds?: number; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = options?.details;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** Тело ответа об ошибке. */
export interface ApiErrorBody {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly details?: ApiErrorDetails;
  };
}

export function toErrorBody(error: ApiError, requestId: string): ApiErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

/**
 * Приводит произвольную ошибку к безопасной для клиента.
 *
 * Всё, что не является ApiError, считается внутренним сбоем: наружу идёт
 * общее сообщение, а подробности остаются в логе, где их увидит только
 * оператор. Так текст ошибки PostgreSQL или провайдера модели не попадёт
 * в ответ.
 */
export function toApiError(error: unknown): ApiError {
  if (isApiError(error)) return error;

  return new ApiError('INTERNAL_ERROR', 'Внутренняя ошибка сервера', { cause: error });
}
