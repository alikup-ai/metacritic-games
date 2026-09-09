import type { DbPool } from './pool.js';

/**
 * Advisory lock PostgreSQL — гарантия «не более одного запуска обработки».
 *
 * Ключевое свойство: блокировка привязана к сессии, поэтому при аварийном
 * завершении процесса СУБД снимает её автоматически. Это защищает от ситуации,
 * когда упавший запуск навсегда заблокировал бы планировщик (ADR-0004).
 */

/** Идентификатор блокировки запуска обработки. */
export const INGESTION_RUN_LOCK_ID = 4_820_100_002;

/** Отдельная блокировка процедуры восстановления при старте (ADR-0010). */
export const STARTUP_RECOVERY_LOCK_ID = 4_820_100_003;

/**
 * Проверяет, удерживает ли кто-либо advisory lock с заданным ключом.
 *
 * Это основной критерий живости процесса (ADR-0010): PostgreSQL снимает
 * блокировку сразу при обрыве сессии, поэтому её отсутствие означает, что
 * владевший ею процесс завершился. В отличие от таймаута, это факт состояния
 * СУБД, а не предположение.
 *
 * Важно: pg_locks.objid имеет тип OID (uint32), поэтому 64-битный ключ нельзя
 * сравнивать напрямую — он раскладывается на classid (старшие 32 бита) и
 * objid (младшие 32 бита).
 */
export async function isLockHeld(pool: DbPool, lockKey: number): Promise<boolean> {
  const classId = Math.floor(lockKey / 2 ** 32);
  const objId = lockKey >>> 0;

  const { rows } = await pool.query<{ held: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_locks
       WHERE locktype = 'advisory'
         AND classid = $1
         AND objid = $2
         AND granted
     ) AS held`,
    [classId, objId],
  );

  return rows[0]?.held ?? false;
}

export interface AcquiredLock {
  /** Освобождает блокировку и возвращает соединение в пул. */
  release(): Promise<void>;
}

/**
 * Пытается захватить блокировку без ожидания.
 * Возвращает null, если блокировка уже занята — вызывающий код должен
 * завершиться со статусом 'skipped', а не ждать.
 */
export async function tryAcquireLock(
  pool: DbPool,
  lockId: number = INGESTION_RUN_LOCK_ID,
): Promise<AcquiredLock | null> {
  // Отдельное соединение: блокировка живёт ровно столько, сколько живёт сессия.
  const client = await pool.connect();

  try {
    const { rows } = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [lockId],
    );

    if (!rows[0]?.acquired) {
      client.release();
      return null;
    }

    let released = false;
    return {
      async release(): Promise<void> {
        if (released) return;
        released = true;
        try {
          await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
        } catch {
          // Соединение могло быть потеряно — тогда СУБД снимет блокировку сама.
        } finally {
          client.release();
        }
      },
    };
  } catch (error) {
    client.release();
    throw error;
  }
}

/**
 * Выполняет callback под блокировкой; при занятой блокировке возвращает
 * { acquired: false } без выполнения.
 */
export async function withLock<T>(
  pool: DbPool,
  fn: () => Promise<T>,
  lockId: number = INGESTION_RUN_LOCK_ID,
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  const lock = await tryAcquireLock(pool, lockId);
  if (!lock) return { acquired: false };

  try {
    return { acquired: true, result: await fn() };
  } finally {
    await lock.release();
  }
}
