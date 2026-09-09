import { createPool, type DbPool } from '../../src/shared/db/pool.js';
import { loadConfig } from '../../src/shared/config/index.js';
import { runMigrations } from '../../src/shared/db/migrate.js';

/**
 * Тестовая БД. Если DATABASE_URL не задан, используется отдельный инстанс
 * из docker-compose.test.yml (порт 5433), чтобы не задеть рабочие данные.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/metacritic_test';

export function createTestPool(): DbPool {
  return createPool(loadConfig({ DATABASE_URL: TEST_DATABASE_URL } as NodeJS.ProcessEnv));
}

export async function setupSchema(pool: DbPool): Promise<void> {
  await runMigrations(pool);
}

/** Очищает данные между тестами, сохраняя схему. */
export async function truncateAll(pool: DbPool): Promise<void> {
  await pool.query(`
    TRUNCATE run_events, daily_claims, runs, processing_days,
             game_platforms, review_snapshots, review_summaries,
             similar_games, video_insights, games
    RESTART IDENTITY CASCADE
  `);
}

export async function isDatabaseAvailable(): Promise<boolean> {
  const pool = createTestPool();
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}
