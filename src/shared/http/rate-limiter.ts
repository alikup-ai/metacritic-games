/**
 * Token bucket — общий ограничитель скорости запросов.
 *
 * Ограничитель один на весь адаптер и разделяется всеми воркерами. Благодаря
 * этому вежливость к источнику не зависит от размера пула: увеличение
 * параллелизма не увеличивает частоту обращений.
 */

export interface RateLimiterOptions {
  /** Разрешённых запросов в секунду. */
  readonly requestsPerSecond: number;
  /** Размер «всплеска»: сколько запросов можно сделать подряд. По умолчанию 1. */
  readonly burst?: number;
  /** Источник времени — подменяется в тестах. */
  readonly now?: () => number;
  /** Функция ожидания — подменяется в тестах. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class TokenBucketRateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private tokens: number;
  private lastRefill: number;
  /** Очередь ожидающих: гарантирует порядок FIFO и отсутствие «гонки» за токен. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions) {
    if (options.requestsPerSecond <= 0) {
      throw new Error('requestsPerSecond должен быть положительным');
    }
    this.capacity = Math.max(1, options.burst ?? 1);
    this.refillPerMs = options.requestsPerSecond / 1000;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  /**
   * Ожидает разрешения на выполнение запроса.
   *
   * Вызовы сериализуются: без этого несколько параллельных воркеров могли бы
   * одновременно увидеть один свободный токен и превысить лимит.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    const run = this.queue.then(() => this.acquireOne(signal));
    // Ошибка одного ожидающего не должна ломать очередь для остальных.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async acquireOne(signal?: AbortSignal): Promise<void> {
    for (;;) {
      throwIfAborted(signal);
      this.refill();

      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }

      const deficit = 1 - this.tokens;
      const waitMs = Math.ceil(deficit / this.refillPerMs);
      await this.sleep(waitMs);
    }
  }

  private refill(): void {
    const current = this.now();
    const elapsed = current - this.lastRefill;
    if (elapsed <= 0) return;

    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = current;
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('Операция отменена');
    error.name = 'AbortError';
    throw error;
  }
}
