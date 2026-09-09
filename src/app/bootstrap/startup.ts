import { hostname } from 'node:os';
import type { Config } from '../../shared/config/index.js';
import type { DbPool } from '../../shared/db/pool.js';
import {
  isLockHeld,
  STARTUP_RECOVERY_LOCK_ID,
  withLock,
} from '../../shared/db/advisory-lock.js';
import { runMigrations } from '../../shared/db/migrate.js';
import { recoverOrphanedRuns } from '../../modules/monitoring/application/recover-orphaned-runs.js';
import { PostgresRunRepository } from '../../modules/monitoring/infrastructure/postgres-run-repository.js';
import type { RecoveryOutcome } from '../../modules/monitoring/domain/run.js';

/**
 * Composition root для процедуры старта приложения.
 *
 * Порядок важен: миграции применяются до восстановления, поскольку recovery
 * обращается к колонкам, добавленным миграцией 004.
 */

/** Идентификатор процесса — только для диагностики, не критерий живости. */
export function buildOwnerId(): string {
  return `${hostname()}:${process.pid}`;
}

export interface StartupResult {
  readonly migrationsApplied: readonly string[];
  readonly recovery: RecoveryOutcome;
}

export async function runStartupSequence(
  pool: DbPool,
  config: Config,
): Promise<StartupResult> {
  const migrationsApplied = await runMigrations(pool);

  const runs = new PostgresRunRepository(pool);

  const recovery = await recoverOrphanedRuns({
    runs,
    isLockHeld: (lockKey) => isLockHeld(pool, lockKey),
    // Отдельная блокировка: параллельно стартующие процессы не выполняют
    // восстановление одновременно.
    withRecoveryLock: async (fn) => {
      const outcome = await withLock(pool, fn, STARTUP_RECOVERY_LOCK_ID);
      return outcome.acquired ? outcome.result : null;
    },
    heartbeatTimeoutMinutes: config.heartbeatTimeoutMinutes,
  });

  return { migrationsApplied, recovery };
}
