import type { RunLock } from '../../modules/monitoring/domain/run.js';
import { INGESTION_RUN_LOCK_ID, tryAcquireLock } from './advisory-lock.js';
import type { DbPool } from './pool.js';

/**
 * Реализация взаимной блокировки запусков на advisory lock PostgreSQL.
 *
 * Блокировка привязана к сессии, поэтому при аварийном завершении процесса
 * СУБД снимает её сама — зависший запуск не блокирует планировщик навсегда
 * (ADR-0010).
 *
 * Ответственность строго ограничена: это защита от лишней параллельной
 * работы. Идемпотентность обеспечивает реестр заявок, а не блокировка.
 */
export class PostgresRunLock implements RunLock {
  readonly lockKey: number;

  constructor(
    private readonly pool: DbPool,
    lockKey: number = INGESTION_RUN_LOCK_ID,
  ) {
    this.lockKey = lockKey;
  }

  async tryAcquire(): Promise<{ release(): Promise<void> } | null> {
    return tryAcquireLock(this.pool, this.lockKey);
  }
}
