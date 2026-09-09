/** Доменная модель запусков обработки и их событий. */

export type RunTrigger = 'cron' | 'manual';

/**
 * Статусы запуска.
 * 'blocked' отделён от 'failed' намеренно: блокировка со стороны источника
 * требует прекратить попытки, а обычная ошибка — нет.
 */
export type RunStatus = 'running' | 'completed' | 'failed' | 'skipped' | 'blocked';

export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Run {
  readonly id: string;
  readonly trigger: RunTrigger;
  readonly status: RunStatus;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly plannedCount: number;
  readonly claimedCount: number;
  readonly processedCount: number;
  readonly failedCount: number;
  readonly error: string | null;

  /** Отметка живости процесса; вторичный критерий orphaned run (ADR-0010). */
  readonly heartbeatAt: Date;
  /** Идентификатор владельца — для диагностики, не критерий живости. */
  readonly ownerId: string | null;
  /** Ключ advisory lock; его наличие в pg_locks — основной критерий живости. */
  readonly lockKey: number | null;
  readonly recoveredAt: Date | null;
  readonly recoveryReason: string | null;

  /** Сутки обработки; null у запусков до миграции 007. */
  readonly processingDay: string | null;
  readonly sourceStrategy: string | null;
  /** Страница листинга на момент завершения — подсказка, не истина. */
  readonly lastPageHint: number | null;
  readonly pagesScanned: number;
}

/** Результат восстановления осиротевших запусков при старте. */
export interface RecoveryOutcome {
  readonly recovered: readonly {
    readonly runId: string;
    readonly reason: string;
  }[];
  /** Запуски, признанные живыми и намеренно не тронутые. */
  readonly skippedActive: number;
}

export interface RunEvent {
  readonly id: string;
  readonly runId: string;
  readonly ts: Date;
  readonly level: EventLevel;
  readonly stage: string | null;
  readonly sourceSlug: string | null;
  readonly message: string;
  readonly payload: Record<string, unknown> | null;
}

export interface RunCounters {
  readonly plannedCount?: number;
  readonly claimedCount?: number;
  readonly processedCount?: number;
  readonly failedCount?: number;
}

export interface StartRunOptions {
  readonly ownerId?: string;
  readonly lockKey?: number;
  /** Сутки обработки, к которым относится запуск. */
  readonly processingDay?: string;
}

/** Контекст выборки кандидатов — заполняется по ходу запуска. */
export interface RunDailyContext {
  readonly sourceStrategy?: string;
  readonly lastPageHint?: number;
  readonly pagesScanned?: number;
}

/**
 * Порт взаимной блокировки запусков.
 *
 * Объявлен в domain, чтобы application не зависел от PostgreSQL advisory
 * lock. Блокировка защищает от лишней параллельной работы; идемпотентность
 * при этом обеспечивается реестром заявок, а не ею.
 */
export interface RunLock {
  /**
   * Пытается захватить блокировку без ожидания.
   * Возвращает null, если она уже занята другим процессом.
   */
  tryAcquire(): Promise<{ release(): Promise<void> } | null>;

  /** Ключ блокировки — сохраняется в запуске для восстановления. */
  readonly lockKey: number;
}

export interface RunRepository {
  start(trigger: RunTrigger, options?: StartRunOptions): Promise<Run>;

  /** Обновляет отметку живости работающего запуска. */
  touchHeartbeat(runId: string): Promise<void>;

  /** Сохраняет контекст выборки кандидатов. */
  updateDailyContext(runId: string, context: RunDailyContext): Promise<void>;

  /**
   * Находит запуски в статусе 'running', владелец которых, судя по всему,
   * завершился. Критерий описан в ADR-0010: сначала проверяется наличие
   * advisory lock, и лишь при его отсутствии в записи — heartbeat.
   */
  findOrphanedRuns(params: {
    heartbeatTimeoutMinutes: number;
    isLockHeld: (lockKey: number) => Promise<boolean>;
  }): Promise<readonly Run[]>;

  /**
   * Помечает конкретный запуск восстановленным.
   *
   * Возвращает true, только если строка была переведена ИМЕННО этим вызовом.
   * Условие `status = 'running'` внутри UPDATE делает операцию идемпотентной
   * и не даёт двум процессам восстановить один запуск.
   */
  markRecovered(params: { runId: string; reason: string }): Promise<boolean>;

  finish(params: {
    runId: string;
    status: Exclude<RunStatus, 'running'>;
    counters?: RunCounters;
    error?: string | null;
  }): Promise<Run>;

  incrementCounters(runId: string, delta: RunCounters): Promise<void>;

  findById(runId: string): Promise<Run | null>;

  findActive(): Promise<Run | null>;

  /** Все запуски в статусе 'running' — включая живые. */
  listRunning(): Promise<readonly Run[]>;

  listRecent(limit: number): Promise<readonly Run[]>;

  appendEvent(event: {
    runId: string;
    level: EventLevel;
    stage?: string | null;
    sourceSlug?: string | null;
    message: string;
    payload?: Record<string, unknown> | null;
  }): Promise<RunEvent>;

  /** События запуска после указанного курсора — основа докачки для SSE. */
  listEvents(params: {
    runId: string;
    afterId?: string;
    limit: number;
  }): Promise<readonly RunEvent[]>;
}
