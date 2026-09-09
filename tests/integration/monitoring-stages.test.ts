import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbPool } from '../../src/shared/db/pool.js';
import { PostgresRunRepository } from '../../src/modules/monitoring/infrastructure/postgres-run-repository.js';
import {
  PostgresClaimRepository,
  PostgresProcessingDayRepository,
} from '../../src/modules/ingestion/infrastructure/postgres-claim-repository.js';
import { PostgresGameRepository } from '../../src/modules/catalog/infrastructure/postgres-game-repository.js';
import { createTestPool, setupSchema, truncateAll } from './helpers.js';

/**
 * Счётчики стадий для интерфейса мониторинга.
 *
 * Проверяются на реальной PostgreSQL: агрегат идёт по jsonb-полю stages.
 */

let pool: DbPool;
let runs: PostgresRunRepository;
let claims: PostgresClaimRepository;
let days: PostgresProcessingDayRepository;
let games: PostgresGameRepository;

const DAY = '2026-09-09';

beforeAll(async () => {
  pool = createTestPool();
  await setupSchema(pool);
  runs = new PostgresRunRepository(pool);
  claims = new PostgresClaimRepository(pool);
  days = new PostgresProcessingDayRepository(pool);
  games = new PostgresGameRepository(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
});

async function seedClaims(runId: string, stages: string[]): Promise<void> {
  await days.ensureDay(DAY);
  const { game } = await games.upsert({
    source: 'metacritic',
    sourceSlug: 'g1',
    parserVersion: 'v1',
    title: 'Игра',
    developerStatus: 'unknown',
  });

  for (const [index, json] of stages.entries()) {
    await pool.query(
      `INSERT INTO daily_claims
         (processing_day, source, source_slug, game_id, run_id, status, stages, completed_at)
       VALUES ($1, 'metacritic', $2, $3, $4, 'done', $5::jsonb, now())`,
      [DAY, `slug-${index}`, game.id, runId, json],
    );
  }
}

describe('Счётчики стадий запуска', () => {
  it('считает выполненные, пропущенные и упавшие', async () => {
    const run = await runs.start('manual', { processingDay: DAY });

    await seedClaims(run.id, [
      '{"fetchGame":{"status":"done"},"fetchReviews":{"status":"done"},"summarize":{"status":"done"}}',
      '{"fetchGame":{"status":"done"},"fetchReviews":{"status":"done"},"summarize":{"status":"skipped"}}',
      '{"fetchGame":{"status":"done"},"fetchReviews":{"status":"failed"},"summarize":{"status":"skipped"}}',
    ]);

    const stages = await claims.countStagesByRun(run.id);
    const byName = new Map(stages.map((s) => [s.stage, s]));

    expect(byName.get('fetchGame')).toMatchObject({ done: 3, failed: 0, skipped: 0 });
    expect(byName.get('fetchReviews')).toMatchObject({ done: 2, failed: 1 });
    expect(byName.get('summarize')).toMatchObject({ done: 1, skipped: 2 });
  });

  it('запуск без заявок даёт пустой список', async () => {
    const run = await runs.start('manual', { processingDay: DAY });
    expect(await claims.countStagesByRun(run.id)).toEqual([]);
  });

  it('стадии другого запуска не учитываются', async () => {
    const first = await runs.start('manual', { processingDay: DAY });
    await seedClaims(first.id, ['{"fetchGame":{"status":"done"}}']);
    await runs.finish({ runId: first.id, status: 'completed' });

    const second = await runs.start('cron', { processingDay: DAY });
    expect(await claims.countStagesByRun(second.id)).toEqual([]);
  });

  it('стадии отсортированы по имени — порядок устойчив', async () => {
    const run = await runs.start('manual', { processingDay: DAY });
    await seedClaims(run.id, [
      '{"summarize":{"status":"done"},"fetchGame":{"status":"done"},"fetchReviews":{"status":"done"}}',
    ]);

    const names = (await claims.countStagesByRun(run.id)).map((s) => s.stage);
    expect(names).toEqual([...names].sort());
  });
});
