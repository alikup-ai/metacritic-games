/**
 * Типизированные ошибки получения данных.
 *
 * Категория ошибки определяет реакцию: 403 требует прекратить работу, 429 —
 * подождать, 5xx — повторить, ошибка разбора — сохранить образец и пропустить
 * элемент. Строковые сообщения для этого непригодны.
 */

export type IngestionErrorCategory =
  /** Таймаут, обрыв соединения, DNS — повторяемо */
  | 'network'
  /** Превышен лимит запросов; учитывать Retry-After */
  | 'rate_limited'
  /** Доступ заблокирован источником — повторять НЕЛЬЗЯ */
  | 'blocked'
  /** Ошибка на стороне источника (5xx) — повторяемо */
  | 'server_error'
  /** 4xx кроме 403/429 — повтор не поможет */
  | 'client_error'
  /** Страница получена, но структура не распознана */
  | 'parse_error'
  /** Операция отменена вызывающей стороной */
  | 'aborted';

export interface IngestionErrorContext {
  readonly url?: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly attempt?: number;
  readonly detail?: string;
}

export class IngestionError extends Error {
  readonly category: IngestionErrorCategory;
  readonly context: IngestionErrorContext;

  constructor(
    category: IngestionErrorCategory,
    message: string,
    context: IngestionErrorContext = {},
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions);
    this.name = 'IngestionError';
    this.category = category;
    this.context = context;
  }

  /**
   * Можно ли повторить запрос.
   * `blocked` намеренно невозвратна: повтор при блокировке усугубляет ситуацию.
   */
  get retryable(): boolean {
    return (
      this.category === 'network' ||
      this.category === 'rate_limited' ||
      this.category === 'server_error'
    );
  }
}

export function isIngestionError(value: unknown): value is IngestionError {
  return value instanceof IngestionError;
}

/** Ошибка разбора: структура страницы не соответствует ожидаемой. */
export class ParseError extends IngestionError {
  constructor(message: string, context: IngestionErrorContext = {}) {
    super('parse_error', message, context);
    this.name = 'ParseError';
  }
}
