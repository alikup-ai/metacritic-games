import type { IngestionEventSink } from '../domain/ingestion-events.js';
import { noopEventSink } from '../domain/ingestion-events.js';
import type {
  RunDailyProcessingResult,
  RunDailyProcessingUseCase,
} from './run-daily-processing.js';

/**
 * Почасовой планировщик.
 *
 * Сам обработку не выполняет — только инициирует запуск через application
 * service. Разделение важно: планировщик отвечает за «когда», а не «что».
 *
 * Защита от наложения запусков двухуровневая:
 *   1) флаг выполнения внутри планировщика — не даёт запустить второй тик,
 *      пока предыдущий не завершён;
 *   2) блокировка в RunDailyProcessing — защищает от других процессов.
 *
 * Одного setInterval недостаточно: он продолжает выдавать тики независимо
 * от того, завершилась ли предыдущая работа.
 */

export interface SchedulerTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface DailyProcessingSchedulerDeps {
  readonly runDailyProcessing: RunDailyProcessingUseCase;
  readonly intervalMs: number;
  readonly timers: SchedulerTimers;
  readonly events?: IngestionEventSink;
  /** Выполнить запуск сразу при старте, не дожидаясь первого тика. */
  readonly runOnStart?: boolean;
  readonly onError?: (error: unknown) => void;
}

export class DailyProcessingScheduler {
  private handle: unknown = null;
  private running = false;
  /** Промис текущего запуска — нужен для корректной остановки. */
  private inFlight: Promise<unknown> | null = null;
  private stopped = false;

  private readonly events: IngestionEventSink;

  constructor(private readonly deps: DailyProcessingSchedulerDeps) {
    this.events = deps.events ?? noopEventSink;
  }

  /** Признак активного планировщика — для диагностики и тестов. */
  get isScheduled(): boolean {
    return this.handle !== null;
  }

  /** Признак выполняющегося запуска. */
  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.handle !== null) return;

    this.stopped = false;
    this.handle = this.deps.timers.setInterval(() => {
      void this.tick();
    }, this.deps.intervalMs);

    if (this.deps.runOnStart) {
      void this.tick();
    }
  }

  /**
   * Останавливает планировщик, дожидаясь уже начатого запуска.
   * Прерывать работу на середине нельзя: заявки остались бы захваченными
   * до истечения аренды.
   */
  async stop(): Promise<void> {
    this.stopped = true;

    if (this.handle !== null) {
      this.deps.timers.clearInterval(this.handle);
      this.handle = null;
    }

    if (this.inFlight) {
      await this.inFlight.catch(() => undefined);
    }
  }

  /** Выполняет один тик вручную — используется в тестах. */
  async tick(): Promise<RunDailyProcessingResult | null> {
    // Предыдущий запуск ещё идёт: новый тик пропускается, не накапливаясь.
    if (this.running || this.stopped) return null;

    this.running = true;
    const execution = this.deps.runDailyProcessing
      .execute({ trigger: 'cron' })
      .catch((error: unknown) => {
        // Ошибка одного тика не должна останавливать планировщик:
        // следующий час может оказаться удачнее.
        this.deps.onError?.(error);
        return null;
      })
      .finally(() => {
        this.running = false;
        this.inFlight = null;
      });

    this.inFlight = execution;
    return execution;
  }
}
