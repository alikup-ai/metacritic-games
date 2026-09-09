/**
 * Порт провайдера языковой модели (ADR-0006).
 *
 * Объявлен в domain: application не знает ни про SDK, ни про HTTP, ни про
 * конкретного поставщика. Замена провайдера — это новый адаптер в
 * infrastructure, без изменений в бизнес-логике.
 */

import type { ReviewKind } from '../../reviews/domain/review.js';

/**
 * Отзыв, подготовленный для передачи модели.
 *
 * `ref` — метка внутри одного запроса (r1, r2, …). Модель не видит наших
 * внутренних идентификаторов и ссылается только на неё; сопоставление с
 * ключом отзыва хранится на нашей стороне.
 */
export interface PreparedReview {
  readonly ref: string;
  readonly reviewKey: string;
  readonly score: number | null;
  readonly date: string | null;
  readonly text: string;
  /** Текст был сокращён по лимиту: модель не должна считать его законченным. */
  readonly truncated: boolean;
  /** Сколько одинаковых отзывов схлопнуто в этот. */
  readonly duplicates: number;
  readonly source: string;
}

/** Запрос на анализ. Структурированный, а не склеенный текст. */
export interface LlmAnalysisRequest {
  readonly kind: ReviewKind;
  readonly gameTitle: string;
  readonly platformSlug: string;
  readonly reviews: readonly PreparedReview[];
  readonly analyzedCount: number;
  readonly totalAvailable: number;
  readonly promptVersion: string;
  readonly samplingVersion: string;
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
}

/** Пункт вывода со ссылками на отзывы-основания. */
export interface AnalysisPoint {
  readonly text: string;
  readonly evidenceRefs: readonly string[];
}

export type ThemeSentiment = 'positive' | 'negative' | 'neutral' | 'mixed';

export interface AnalysisTheme {
  readonly name: string;
  readonly sentiment: ThemeSentiment;
  readonly description: string;
  readonly evidenceRefs: readonly string[];
}

export type AnalysisConfidence = 'low' | 'medium' | 'high';

/** Разобранный и проверенный ответ модели. */
export interface LlmAnalysisContent {
  readonly summary: string;
  readonly liked: readonly AnalysisPoint[];
  readonly disliked: readonly AnalysisPoint[];
  readonly themes: readonly AnalysisTheme[];
  readonly confidence: AnalysisConfidence;
}

/** Расход токенов; заполняется только если провайдер его сообщает. */
export interface LlmUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface LlmAnalysisResult {
  readonly content: LlmAnalysisContent;
  /** Фактически использованная модель, а не запрошенная. */
  readonly model: string;
  readonly usage: LlmUsage;
}

/**
 * Категории отказов модели.
 *
 * Разделены по признаку «имеет ли смысл повторять»: повтор при невалидном
 * ответе почти наверняка даст такой же результат, а при таймауте — нет.
 */
export type LlmErrorCategory =
  /** Таймаут — повторяемо */
  | 'timeout'
  /** Превышен лимит частоты — повторяемо с учётом Retry-After */
  | 'rate_limited'
  /** Ошибка на стороне провайдера — повторяемо */
  | 'server_error'
  /** Провайдер недоступен (сеть) — повторяемо */
  | 'unavailable'
  /** Некорректный запрос или отказ провайдера — повтор не поможет */
  | 'client_error'
  /** Ответ не является корректным JSON */
  | 'malformed_json'
  /** Ответ не соответствует схеме */
  | 'schema_invalid'
  /** Ссылки на несуществующие отзывы — признак галлюцинации */
  | 'evidence_invalid'
  /** Превышен лимит токенов — нужно уменьшить выборку, а не повторять */
  | 'token_limit'
  /** Операция отменена вызывающей стороной */
  | 'aborted';

export class LlmError extends Error {
  readonly category: LlmErrorCategory;
  readonly retryAfterMs: number | undefined;

  constructor(
    category: LlmErrorCategory,
    message: string,
    options: { retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'LlmError';
    this.category = category;
    this.retryAfterMs = options.retryAfterMs;
  }

  /**
   * Повторять имеет смысл только при транзиентных сбоях.
   * Невалидный ответ и превышение лимита токенов повтором не лечатся.
   */
  get retryable(): boolean {
    return (
      this.category === 'timeout' ||
      this.category === 'rate_limited' ||
      this.category === 'server_error' ||
      this.category === 'unavailable'
    );
  }
}

export function isLlmError(value: unknown): value is LlmError {
  return value instanceof LlmError;
}

export interface LlmProvider {
  /** Имя модели из конфигурации — для ключа идемпотентности. */
  readonly model: string;

  analyzeReviews(request: LlmAnalysisRequest): Promise<LlmAnalysisResult>;
}
