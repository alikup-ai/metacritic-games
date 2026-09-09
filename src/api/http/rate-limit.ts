/**
 * Ограничение частоты защищённых операций (ADR-0007).
 *
 * Счётчик в памяти процесса. Для одного демо-стенда этого достаточно;
 * при нескольких экземплярах предел станет пообъектным — ограничение
 * задокументировано, а не замаскировано.
 *
 * Назначение — не дать перебирать токен и запускать обработку в цикле,
 * а не полноценная защита от распределённой нагрузки.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Сколько ждать до следующей попытки; заполняется при отказе. */
  readonly retryAfterSeconds: number;
  readonly remaining: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly options: {
      readonly windowMs: number;
      readonly max: number;
      readonly now?: () => number;
    },
  ) {}

  private currentTime(): number {
    return this.options.now?.() ?? Date.now();
  }

  check(key: string): RateLimitDecision {
    const now = this.currentTime();
    const bucket = this.buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.options.windowMs });
      return { allowed: true, retryAfterSeconds: 0, remaining: this.options.max - 1 };
    }

    if (bucket.count >= this.options.max) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
        remaining: 0,
      };
    }

    bucket.count += 1;
    return {
      allowed: true,
      retryAfterSeconds: 0,
      remaining: this.options.max - bucket.count,
    };
  }

  /** Убирает истёкшие корзины, чтобы карта не росла без предела. */
  prune(): void {
    const now = this.currentTime();
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key);
    }
  }
}
