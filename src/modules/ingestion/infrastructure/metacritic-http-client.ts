import { IngestionError } from '../domain/ingestion-errors.js';
import {
  TokenBucketRateLimiter,
  throwIfAborted,
  type RateLimiterOptions,
} from '../../../shared/http/rate-limiter.js';
import { silentLogger, type Logger } from '../../../shared/logging/logger.js';
import { parseRetryAfter } from '../../../shared/http/retry-after.js';

// Реализация переехала в shared: заголовок нужен любому внешнему клиенту.
export { parseRetryAfter };

/**
 * HTTP-клиент для Metacritic.
 *
 * Политика обработки статусов (ARCHITECTURE.md §7):
 *   403 -> немедленное прекращение БЕЗ повторов (повтор усугубляет блокировку)
 *   429 -> повтор с учётом Retry-After
 *   5xx -> повтор как транзиентной ошибки
 *   таймаут/обрыв -> ограниченное число повторов
 *   прочие 4xx -> без повторов, повтор не поможет
 *
 * Обход блокировок и CAPTCHA не реализуется намеренно: при 403 клиент
 * останавливается и сообщает об этом.
 */

export interface HttpFetchResult {
  readonly url: string;
  readonly status: number;
  readonly body: string;
  readonly durationMs: number;
  readonly attempts: number;
}

export interface MetacriticHttpClientOptions {
  readonly baseUrl?: string;
  readonly userAgent: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly requestsPerSecond?: number;
  readonly logger?: Logger;
  /** Подменяется в тестах. */
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly rateLimiter?: TokenBucketRateLimiter;
  readonly rateLimiterOptions?: Partial<RateLimiterOptions>;
  /** Верхняя граница ожидания по Retry-After — защита от абсурдных значений. */
  readonly maxRetryAfterMs?: number;
  /** Источник случайности для jitter; подменяется в тестах. */
  readonly random?: () => number;
}

const DEFAULT_BASE_URL = 'https://www.metacritic.com';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RPS = 1;
const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;
const BASE_BACKOFF_MS = 1_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class MetacriticHttpClient {
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxRetryAfterMs: number;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly limiter: TokenBucketRateLimiter;
  private readonly random: () => number;

  constructor(options: MetacriticHttpClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.userAgent = options.userAgent;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
    this.logger = options.logger ?? silentLogger;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.limiter =
      options.rateLimiter ??
      new TokenBucketRateLimiter({
        requestsPerSecond: options.requestsPerSecond ?? DEFAULT_RPS,
        ...options.rateLimiterOptions,
      });

    if (!this.userAgent || this.userAgent.trim().length === 0) {
      throw new Error('userAgent обязателен: бот должен честно представляться');
    }

    // HTTP-заголовки — ByteString: символы вне Latin-1 приводят к TypeError
    // уже внутри fetch. Проверяем при сборке клиента, чтобы ошибка возникала
    // на старте, а не в середине обхода.
    // Latin-1 проверяется по коду символа, а не регуляркой с
    // управляющими символами.
    if ([...this.userAgent].some((char) => char.charCodeAt(0) > 0xff)) {
      throw new Error(
        'userAgent должен содержать только символы Latin-1: ' +
          'HTTP-заголовки не допускают кириллицу и другие многобайтовые символы',
      );
    }
  }

  resolveUrl(path: string): string {
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  async get(path: string, signal?: AbortSignal): Promise<HttpFetchResult> {
    const url = this.resolveUrl(path);
    const startedAt = Date.now();
    let lastError: IngestionError | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      throwIfAborted(signal);
      await this.limiter.acquire(signal);

      try {
        const result = await this.attempt(url, attempt, signal, startedAt);

        this.logger.info('Запрос к источнику выполнен', {
          source: 'metacritic',
          operation: 'http_get',
          url,
          status: result.status,
          durationMs: result.durationMs,
          attempts: attempt,
          // Размер, а не содержимое: полный HTML в логи не попадает
          responseBytes: result.body.length,
        });

        return result;
      } catch (error) {
        if (isAbortError(error)) {
          throw new IngestionError('aborted', 'Запрос отменён', { url, attempt });
        }

        const ingestionError = toIngestionError(error, url, attempt);
        lastError = ingestionError;

        // Блокировка и клиентские ошибки повторам не подлежат.
        if (!ingestionError.retryable || attempt >= this.maxAttempts) {
          this.logger.warn('Запрос к источнику завершился ошибкой', {
            source: 'metacritic',
            operation: 'http_get',
            url,
            attempts: attempt,
            status: ingestionError.context.status,
            errorCategory: ingestionError.category,
            retryable: ingestionError.retryable,
          });
          throw ingestionError;
        }

        const delayMs = this.computeDelay(ingestionError, attempt);
        this.logger.warn('Повтор запроса после ошибки', {
          source: 'metacritic',
          operation: 'http_get',
          url,
          attempt,
          nextAttemptInMs: delayMs,
          errorCategory: ingestionError.category,
          status: ingestionError.context.status,
        });

        await this.sleep(delayMs);
      }
    }

    throw (
      lastError ??
      new IngestionError('network', 'Запрос не выполнен', { url, attempt: this.maxAttempts })
    );
  }

  private async attempt(
    url: string,
    attempt: number,
    signal: AbortSignal | undefined,
    startedAt: number,
  ): Promise<HttpFetchResult> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (response.status === 403) {
        throw new IngestionError(
          'blocked',
          'Источник отклонил запрос (403). Повторы прекращены',
          { url, status: 403, attempt },
        );
      }

      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        throw new IngestionError('rate_limited', 'Превышен лимит запросов (429)', {
          url,
          status: 429,
          attempt,
          // Поле добавляется только когда сервер его прислал: при
          // exactOptionalPropertyTypes явный undefined недопустим.
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        });
      }

      if (response.status >= 500) {
        throw new IngestionError('server_error', `Ошибка источника (${response.status})`, {
          url,
          status: response.status,
          attempt,
        });
      }

      if (!response.ok) {
        throw new IngestionError('client_error', `Неожиданный статус ${response.status}`, {
          url,
          status: response.status,
          attempt,
        });
      }

      const body = await response.text();

      // Пустое тело при статусе 200 — не успех, а нераспознанный ответ.
      if (body.trim().length === 0) {
        throw new IngestionError('parse_error', 'Источник вернул пустой ответ', {
          url,
          status: response.status,
          attempt,
        });
      }

      return {
        url,
        status: response.status,
        body,
        durationMs: Date.now() - startedAt,
        attempts: attempt,
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Экспоненциальная задержка с джиттером.
   * Для 429 приоритет у Retry-After, если сервер его указал.
   */
  private computeDelay(error: IngestionError, attempt: number): number {
    const retryAfter = error.context.retryAfterMs;
    if (retryAfter !== undefined && retryAfter > 0) {
      return Math.min(retryAfter, this.maxRetryAfterMs);
    }

    const exponential = BASE_BACKOFF_MS * 2 ** (attempt - 1);
    // Джиттер до 30% — разводит одновременные повторы
    const jitter = exponential * 0.3 * this.random();
    return Math.round(exponential + jitter);
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

function toIngestionError(error: unknown, url: string, attempt: number): IngestionError {
  if (error instanceof IngestionError) return error;

  const message = error instanceof Error ? error.message : String(error);
  return new IngestionError('network', `Сетевая ошибка: ${message}`, { url, attempt }, {
    cause: error,
  });
}
