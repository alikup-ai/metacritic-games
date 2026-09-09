import pg from 'pg';
import type { Config } from '../config/index.js';

const { Pool, types } = pg;

/**
 * Пул подключений к PostgreSQL.
 *
 * Настройки типов важны для корректности:
 * - DATE возвращается строкой 'YYYY-MM-DD', а не Date. Иначе драйвер применил бы
 *   локальную зону сервера и день-план поехал бы относительно PROCESSING_TIMEZONE
 *   (ADR-0002).
 * - BIGINT (int8) возвращается строкой по умолчанию; для счётчиков просмотров и
 *   курсора run_events приводим к number там, где значение заведомо безопасно.
 */

// 1082 = DATE. Возвращаем как есть, без конвертации в Date.
types.setTypeParser(1082, (value: string) => value);

// 1700 = NUMERIC. Возвращаем строкой, чтобы не терять точность;
// приведение делает репозиторий явно.
types.setTypeParser(1700, (value: string) => value);

export type DbPool = pg.Pool;
export type DbClient = pg.PoolClient;

export function createPool(config: Config): DbPool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    statement_timeout: config.dbStatementTimeoutMs,
    // Ошибка простаивающего клиента не должна ронять процесс
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on('error', (err) => {
    // Клиент в простое может быть закрыт со стороны сервера — это не фатально.
    console.error('[db] ошибка простаивающего клиента:', err.message);
  });

  return pool;
}

/**
 * Выполняет callback в транзакции, гарантируя COMMIT/ROLLBACK и возврат клиента.
 */
export async function withTransaction<T>(
  pool: DbPool,
  fn: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Соединение могло быть уже потеряно — исходную ошибку это не меняет.
    }
    throw error;
  } finally {
    client.release();
  }
}
