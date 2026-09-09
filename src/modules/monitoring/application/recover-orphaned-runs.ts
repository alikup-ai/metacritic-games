import type { RecoveryOutcome, RunRepository } from '../domain/run.js';

/**
 * Восстановление осиротевших запусков при старте приложения (ADR-0010).
 *
 * Задача: после аварийного завершения процесса строка runs остаётся в статусе
 * 'running'. Уникальный частичный индекс runs_single_active_idx тогда навсегда
 * блокирует последующие запуски — сервис молча перестаёт работать.
 *
 * Критерий "осиротевшего" запуска НЕ основан на «running дольше N минут».
 * Основной признак — исчезновение advisory lock из pg_locks: СУБД снимает его
 * при обрыве сессии, поэтому его отсутствие означает, что владелец завершился.
 * Heartbeat используется лишь как запасной путь для записей без lock_key.
 */

export interface RecoverOrphanedRunsDeps {
  readonly runs: RunRepository;
  /** Проверка, удерживается ли advisory lock (обычно isLockHeld из shared/db). */
  readonly isLockHeld: (lockKey: number) => Promise<boolean>;
  /**
   * Сериализация процедуры между процессами. Возвращает результат callback
   * либо null, если блокировку взять не удалось (значит, восстановление уже
   * выполняет другой процесс).
   */
  readonly withRecoveryLock: <T>(fn: () => Promise<T>) => Promise<T | null>;
  readonly heartbeatTimeoutMinutes: number;
}

const EMPTY: RecoveryOutcome = { recovered: [], skippedActive: 0 };

export async function recoverOrphanedRuns(
  deps: RecoverOrphanedRunsDeps,
): Promise<RecoveryOutcome> {
  const result = await deps.withRecoveryLock(async () => {
    // Все запуски в статусе 'running' — часть из них живые.
    const active = await deps.runs.listRunning();
    const orphaned = await deps.runs.findOrphanedRuns({
      heartbeatTimeoutMinutes: deps.heartbeatTimeoutMinutes,
      isLockHeld: deps.isLockHeld,
    });

    // Живые запуски намеренно не трогаем — это требование «не конфликтовать
    // с реально работающим run».
    const skippedActive = active.length - orphaned.length;
    const recovered: { runId: string; reason: string }[] = [];

    for (const run of orphaned) {
      const reason =
        run.lockKey !== null
          ? `Запуск восстановлен при старте: advisory lock ${run.lockKey} не удерживается — ` +
            'процесс-владелец завершился аварийно'
          : `Запуск восстановлен при старте: отметка живости не обновлялась дольше ` +
            `${deps.heartbeatTimeoutMinutes} мин (lock_key отсутствует)`;

      // Условный UPDATE внутри markRecovered гарантирует, что событие запишет
      // только тот процесс, который фактически перевёл строку.
      const claimed = await deps.runs.markRecovered({ runId: run.id, reason });
      if (!claimed) continue;

      recovered.push({ runId: run.id, reason });

      // Причина восстановления сохраняется в run_events для аудита.
      await deps.runs.appendEvent({
        runId: run.id,
        level: 'warn',
        stage: 'startup_recovery',
        message: reason,
        payload: {
          previousStatus: 'running',
          newStatus: 'failed',
          startedAt: run.startedAt.toISOString(),
          heartbeatAt: run.heartbeatAt.toISOString(),
          lockKey: run.lockKey,
          ownerId: run.ownerId,
        },
      });
    }

    return { recovered, skippedActive };
  });

  // Блокировку держит другой процесс — он и выполняет восстановление.
  if (result === null) return EMPTY;

  return result;
}
