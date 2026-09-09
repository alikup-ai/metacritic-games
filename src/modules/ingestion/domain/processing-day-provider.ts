import { resolveProcessingDay } from './claim.js';

/**
 * Источник текущих суток обработки и времени.
 *
 * Application-код не обращается к Date.now() напрямую: иначе поведение на
 * границе суток невозможно проверить тестом, а таймзона незаметно
 * привязалась бы к настройкам машины (ADR-0002, решение OQ-1).
 */
export interface ProcessingDayProvider {
  /** Календарные сутки в формате YYYY-MM-DD в настроенной таймзоне. */
  currentProcessingDay(): string;

  /** Текущий момент времени. */
  now(): Date;

  /** Настроенная таймзона — для диагностики и логов. */
  readonly timeZone: string;
}

export interface SystemProcessingDayProviderOptions {
  readonly timeZone: string;
  /** Подменяется в тестах; по умолчанию — системные часы. */
  readonly clock?: () => Date;
}

export class SystemProcessingDayProvider implements ProcessingDayProvider {
  readonly timeZone: string;
  private readonly clock: () => Date;

  constructor(options: SystemProcessingDayProviderOptions) {
    this.timeZone = options.timeZone;
    this.clock = options.clock ?? (() => new Date());
  }

  currentProcessingDay(): string {
    return resolveProcessingDay(this.clock(), this.timeZone);
  }

  now(): Date {
    return this.clock();
  }
}

/**
 * Провайдер с управляемым временем — для тестов.
 * Позволяет проверить переход через границу суток без ожидания.
 */
export class FixedProcessingDayProvider implements ProcessingDayProvider {
  constructor(
    private current: Date,
    readonly timeZone = 'UTC',
  ) {}

  currentProcessingDay(): string {
    return resolveProcessingDay(this.current, this.timeZone);
  }

  now(): Date {
    return this.current;
  }

  /** Сдвигает время вперёд — например, на новые сутки. */
  advanceTo(moment: Date): void {
    this.current = moment;
  }
}
