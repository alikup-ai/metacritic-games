import type { TxContext, UnitOfWork } from '../../modules/catalog/domain/unit-of-work.js';
import type { DbClient, DbPool } from './pool.js';

/**
 * Реализация границы транзакции на PostgreSQL.
 *
 * Внутри TxContext прячется клиент пула. Application-слой получает контекст
 * как непрозрачное значение и передаёт его в репозитории, не имея доступа
 * ни к соединению, ни к BEGIN/COMMIT.
 */

interface PostgresTxContext extends TxContext {
  readonly client: DbClient;
}

/** Достаёт исполнителя запросов: клиент транзакции либо сам пул. */
export function resolveExecutor(
  pool: DbPool,
  tx?: TxContext,
): DbPool | DbClient {
  if (!tx) return pool;

  const client = (tx as PostgresTxContext).client;
  if (!client) {
    throw new Error(
      'Передан посторонний TxContext: транзакция создана не этим UnitOfWork',
    );
  }
  return client;
}

export class PostgresUnitOfWork implements UnitOfWork {
  constructor(private readonly pool: DbPool) {}

  async withTransaction<T>(work: (tx: TxContext) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const context = { client } as unknown as PostgresTxContext;
      const result = await work(context);

      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Соединение могло быть потеряно — исходную ошибку это не меняет,
        // а СУБД откатит транзакцию сама при разрыве.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
