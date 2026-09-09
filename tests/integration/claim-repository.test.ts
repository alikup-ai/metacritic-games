import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbPool } from '../../src/shared/db/pool.js';
import {
  PostgresClaimRepository,
  PostgresProcessingDayRepository,
} from '../../src/modules/ingestion/infrastructure/postgres-claim-repository.js';
import { PostgresRunRepository } from '../../src/modules/monitoring/infrastructure/postgres-run-repository.js';
import { createTestPool, setupSchema, truncateAll } from './helpers.js';

/**
 * Проверка семи сценариев из требований к daily_claims (ADR-0004):
 * 1) обычное завершение, 2) падение воркера, 3) истечение аренды,
 * 4) retry, 5) дублирующий job, 6) параллельные воркеры,
 * 7) частичное выполнение стадий.
 */

const DAY = '2026-09-07';
const SOURCE = 'metacritic' as const;

let pool: DbPool;
let claims: PostgresClaimRepository;
let days: PostgresProcessingDayRepository;
let runs: PostgresRunRepository;

beforeAll(async () => {
  pool = createTestPool();
  await setupSchema(pool);
  claims = new PostgresClaimRepository(pool);
  days = new PostgresProcessingDayRepository(pool);
  runs = new PostgresRunRepository(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  await days.ensureDay(DAY);
});

function candidates(...slugs: string[]) {
  return slugs.map((sourceSlug) => ({ source: SOURCE, sourceSlug }));
}

describe('ensureDay — начало нового дня', () => {
  it('создаёт план с фазой new_releases', async () => {
    await truncateAll(pool);
    const day = await days.ensureDay('2026-09-08');
    expect(day.phase).toBe('new_releases');
    expect(day.browsePage).toBe(1);
    expect(day.newReleasesDone).toBe(false);
  });

  it('идемпотентен: повторный вызов не создаёт второй план', async () => {
    const first = await days.ensureDay(DAY);
    const second = await days.ensureDay(DAY);
    expect(second.day).toBe(first.day);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM processing_days WHERE day = $1',
      [DAY],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('безопасен при одновременном вызове (гонка воркеров)', async () => {
    await truncateAll(pool);
    const results = await Promise.all([
      days.ensureDay('2026-09-09'),
      days.ensureDay('2026-09-09'),
      days.ensureDay('2026-09-09'),
    ]);
    expect(results).toHaveLength(3);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM processing_days WHERE day = $1',
      ['2026-09-09'],
    );
    expect(rows[0]?.count).toBe('1');
  });
});

describe('Сценарий 1 — обычное завершение', () => {
  it('claim → стадии → done', async () => {
    const run = await runs.start('cron');
    const claimed = await claims.claimBatch({
      day: DAY,
      runId: run.id,
      candidates: candidates('elden-ring'),
      leaseMinutes: 10,
      limit: 20,
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe('claimed');
    expect(claimed[0]?.leaseUntil).not.toBeNull();

    await claims.markDone({
      day: DAY,
      source: SOURCE,
      sourceSlug: 'elden-ring',
      gameId: null,
      stages: { fetchGame: { status: 'done' } },
    });

    const after = await claims.find(DAY, SOURCE, 'elden-ring');
    expect(after?.status).toBe('done');
    expect(after?.completedAt).not.toBeNull();
    // Аренда снимается: запись больше не участвует в восстановлении
    expect(after?.leaseUntil).toBeNull();
  });
});

describe('Сценарий 5 — дублирующий job', () => {
  it('повторный запуск в тот же день НЕ заявляет игру повторно', async () => {
    const run1 = await runs.start('cron');
    const first = await claims.claimBatch({
      day: DAY,
      runId: run1.id,
      candidates: candidates('elden-ring', 'hades-ii'),
      leaseMinutes: 10,
      limit: 20,
    });
    expect(first).toHaveLength(2);

    await runs.finish({ runId: run1.id, status: 'completed' });

    // Второй запуск с теми же кандидатами
    const run2 = await runs.start('cron');
    const second = await claims.claimBatch({
      day: DAY,
      runId: run2.id,
      candidates: candidates('elden-ring', 'hades-ii'),
      leaseMinutes: 10,
      limit: 20,
    });

    expect(second).toHaveLength(0);
  });

  it('заявляет только новые игры, пропуская уже обработанные', async () => {
    const run1 = await runs.start('cron');
    await claims.claimBatch({
      day: DAY,
      runId: run1.id,
      candidates: candidates('elden-ring'),
      leaseMinutes: 10,
      limit: 20,
    });
    await runs.finish({ runId: run1.id, status: 'completed' });

    const run2 = await runs.start('cron');
    const second = await claims.claimBatch({
      day: DAY,
      runId: run2.id,
      candidates: candidates('elden-ring', 'new-game'),
      leaseMinutes: 10,
      limit: 20,
    });

    expect(second).toHaveLength(1);
    expect(second[0]?.sourceSlug).toBe('new-game');
  });
});

describe('Сценарий 6 — параллельные воркеры', () => {
  it('одну игру захватывает ровно один воркер', async () => {
    const [runA, runB, runC] = await Promise.all([
      runs.start('cron'),
      // Уникальный частичный индекс допускает лишь один 'running',
      // поэтому остальные запуски создаём напрямую.
      pool
        .query<{ id: string }>(
          `INSERT INTO runs (trigger, status, finished_at)
           VALUES ('manual', 'completed', now()) RETURNING id`,
        )
        .then((r) => ({ id: r.rows[0]!.id })),
      pool
        .query<{ id: string }>(
          `INSERT INTO runs (trigger, status, finished_at)
           VALUES ('manual', 'completed', now()) RETURNING id`,
        )
        .then((r) => ({ id: r.rows[0]!.id })),
    ]);

    const results = await Promise.all([
      claims.claimBatch({
        day: DAY,
        runId: runA.id,
        candidates: candidates('contested-game'),
        leaseMinutes: 10,
        limit: 20,
      }),
      claims.claimBatch({
        day: DAY,
        runId: runB.id,
        candidates: candidates('contested-game'),
        leaseMinutes: 10,
        limit: 20,
      }),
      claims.claimBatch({
        day: DAY,
        runId: runC.id,
        candidates: candidates('contested-game'),
        leaseMinutes: 10,
        limit: 20,
      }),
    ]);

    const totalClaimed = results.reduce((sum, r) => sum + r.length, 0);
    expect(totalClaimed).toBe(1);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM daily_claims
       WHERE processing_day = $1 AND source_slug = $2`,
      [DAY, 'contested-game'],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('при конкуренции за набор игр каждая достаётся одному воркеру', async () => {
    const run = await runs.start('cron');
    const slugs = Array.from({ length: 10 }, (_, i) => `game-${i}`);

    const results = await Promise.all([
      claims.claimBatch({
        day: DAY,
        runId: run.id,
        candidates: candidates(...slugs),
        leaseMinutes: 10,
        limit: 10,
      }),
      claims.claimBatch({
        day: DAY,
        runId: run.id,
        candidates: candidates(...slugs),
        leaseMinutes: 10,
        limit: 10,
      }),
    ]);

    const all = results.flat().map((c) => c.sourceSlug);
    expect(new Set(all).size).toBe(all.length); // без дублей
    expect(all.length).toBeLessThanOrEqual(10);
  });
});

describe('Сценарии 2, 3, 4 — падение воркера, истечение аренды, retry', () => {
  it('reaper возвращает протухшую заявку в пул БЕЗ создания дубля', async () => {
    const run = await runs.start('cron');
    await claims.claimBatch({
      day: DAY,
      runId: run.id,
      candidates: candidates('crashed-game'),
      leaseMinutes: 10,
      limit: 20,
    });

    // Имитируем падение воркера: аренда истекла
    await pool.query(
      `UPDATE daily_claims SET lease_until = now() - interval '1 minute'
       WHERE processing_day = $1 AND source_slug = $2`,
      [DAY, 'crashed-game'],
    );

    const result = await claims.reapExpiredLeases({ now: new Date(), maxAttempts: 3 });
    expect(result.revived).toBe(1);

    const revived = await claims.find(DAY, SOURCE, 'crashed-game');
    expect(revived?.status).toBe('pending');
    expect(revived?.runId).toBeNull();

    // Дубля не появилось — обновлена та же строка
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM daily_claims
       WHERE processing_day = $1 AND source_slug = $2`,
      [DAY, 'crashed-game'],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('следующий запуск повторно захватывает восстановленную заявку', async () => {
    const run1 = await runs.start('cron');
    await claims.claimBatch({
      day: DAY,
      runId: run1.id,
      candidates: candidates('retry-game'),
      leaseMinutes: 10,
      limit: 20,
    });
    await pool.query(
      `UPDATE daily_claims SET lease_until = now() - interval '1 minute'
       WHERE processing_day = $1 AND source_slug = $2`,
      [DAY, 'retry-game'],
    );
    await claims.reapExpiredLeases({ now: new Date(), maxAttempts: 3 });
    await runs.finish({ runId: run1.id, status: 'failed' });

    const run2 = await runs.start('cron');
    const reclaimed = await claims.claimBatch({
      day: DAY,
      runId: run2.id,
      candidates: candidates('retry-game'),
      leaseMinutes: 10,
      limit: 20,
    });

    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.status).toBe('claimed');
    // Счётчик попыток вырос — видно, что это повтор
    expect(reclaimed[0]?.attempts).toBeGreaterThan(1);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM daily_claims
       WHERE processing_day = $1 AND source_slug = $2`,
      [DAY, 'retry-game'],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('при исчерпании попыток переводит заявку в failed, а не крутит вечно', async () => {
    const run = await runs.start('cron');
    await claims.claimBatch({
      day: DAY,
      runId: run.id,
      candidates: candidates('doomed-game'),
      leaseMinutes: 10,
      limit: 20,
    });

    await pool.query(
      `UPDATE daily_claims
       SET lease_until = now() - interval '1 minute', attempts = 3
       WHERE processing_day = $1 AND source_slug = $2`,
      [DAY, 'doomed-game'],
    );

    const result = await claims.reapExpiredLeases({ now: new Date(), maxAttempts: 3 });
    expect(result.failed).toBe(1);
    expect(result.revived).toBe(0);

    const claim = await claims.find(DAY, SOURCE, 'doomed-game');
    expect(claim?.status).toBe('failed');
  });

  it('не трогает заявки с действующей арендой', async () => {
    const run = await runs.start('cron');
    await claims.claimBatch({
      day: DAY,
      runId: run.id,
      candidates: candidates('healthy-game'),
      leaseMinutes: 10,
      limit: 20,
    });

    const result = await claims.reapExpiredLeases({ now: new Date(), maxAttempts: 3 });
    expect(result.revived).toBe(0);
    expect(result.failed).toBe(0);

    const claim = await claims.find(DAY, SOURCE, 'healthy-game');
    expect(claim?.status).toBe('claimed');
  });

  it('extendLease продлевает аренду живого воркера', async () => {
    const run = await runs.start('cron');
    const [claimed] = await claims.claimBatch({
      day: DAY,
      runId: run.id,
      candidates: candidates('long-game'),
      leaseMinutes: 1,
      limit: 20,
    });
    const initialLease = claimed!.leaseUntil!;

    const extended = await claims.extendLease({
      day: DAY,
      source: SOURCE,
      sourceSlug: 'long-game',
      leaseMinutes: 30,
      runId: run.id,
    });
    expect(extended).toBe(true);

    const after = await claims.find(DAY, SOURCE, 'long-game');
    expect(after!.leaseUntil!.getTime()).toBeGreaterThan(initialLease.getTime());
  });
});

describe('Сценарий 7 — частично выполненная обработка', () => {
  it('сохраняет прогресс стадий и позволяет продолжить', async () => {
    const run = await runs.start('cron');
    await claims.claimBatch({
      day: DAY,
      runId: run.id,
      candidates: candidates('partial-game'),
      leaseMinutes: 10,
      limit: 20,
    });

    await claims.recordStage({
      day: DAY,
      source: SOURCE,
      sourceSlug: 'partial-game',
      stage: 'fetchGame',
      state: { status: 'done', at: new Date().toISOString() },
    });
    await claims.recordStage({
      day: DAY,
      source: SOURCE,
      sourceSlug: 'partial-game',
      stage: 'fetchReviews',
      state: { status: 'done', at: new Date().toISOString() },
    });
    await claims.recordStage({
      day: DAY,
      source: SOURCE,
      sourceSlug: 'partial-game',
      stage: 'summarize',
      state: { status: 'failed', error: 'timeout' },
    });

    const claim = await claims.find(DAY, SOURCE, 'partial-game');
    expect(claim?.stages.fetchGame?.status).toBe('done');
    expect(claim?.stages.fetchReviews?.status).toBe('done');
    expect(claim?.stages.summarize?.status).toBe('failed');
  });

  it('запись стадии сливается с предыдущими, не затирая их', async () => {
    const run = await runs.start('cron');
    await claims.claimBatch({
      day: DAY,
      runId: run.id,
      candidates: candidates('merge-game'),
      leaseMinutes: 10,
      limit: 20,
    });

    await claims.recordStage({
      day: DAY,
      source: SOURCE,
      sourceSlug: 'merge-game',
      stage: 'fetchGame',
      state: { status: 'done' },
    });
    await claims.recordStage({
      day: DAY,
      source: SOURCE,
      sourceSlug: 'merge-game',
      stage: 'similar',
      state: { status: 'done' },
    });

    const claim = await claims.find(DAY, SOURCE, 'merge-game');
    expect(claim?.stages.fetchGame?.status).toBe('done');
    expect(claim?.stages.similar?.status).toBe('done');
  });

  it('прогресс стадий переживает пометку failed', async () => {
    const run = await runs.start('cron');
    await claims.claimBatch({
      day: DAY,
      runId: run.id,
      candidates: candidates('failed-game'),
      leaseMinutes: 10,
      limit: 20,
    });

    await claims.markFailed({
      day: DAY,
      source: SOURCE,
      sourceSlug: 'failed-game',
      error: 'Ошибка парсинга',
      stages: { fetchGame: { status: 'done' }, fetchReviews: { status: 'failed' } },
    });

    const claim = await claims.find(DAY, SOURCE, 'failed-game');
    expect(claim?.status).toBe('failed');
    expect(claim?.lastError).toContain('Ошибка парсинга');
    expect(claim?.stages.fetchGame?.status).toBe('done');
  });
});

describe('Ограничение размера батча', () => {
  it('заявляет не больше limit игр за раз', async () => {
    const run = await runs.start('cron');
    const slugs = Array.from({ length: 50 }, (_, i) => `bulk-${i}`);

    const claimed = await claims.claimBatch({
      day: DAY,
      runId: run.id,
      candidates: candidates(...slugs),
      leaseMinutes: 10,
      limit: 20,
    });

    expect(claimed).toHaveLength(20);
  });

  it('счётчик заявленного за сутки отражает реальность', async () => {
    const run = await runs.start('cron');
    await claims.claimBatch({
      day: DAY,
      runId: run.id,
      candidates: candidates('a', 'b', 'c'),
      leaseMinutes: 10,
      limit: 20,
    });

    const counts = await claims.countByStatus(DAY);
    expect(counts.claimed).toBe(3);
  });
});

describe('Ограничения целостности БД', () => {
  it('запрещает заявку в статусе claimed без срока аренды', async () => {
    const run = await runs.start('cron');
    await expect(
      pool.query(
        `INSERT INTO daily_claims (processing_day, source, source_slug, run_id, status, lease_until)
         VALUES ($1, $2, 'bad-claim', $3, 'claimed', NULL)`,
        [DAY, SOURCE, run.id],
      ),
    ).rejects.toThrow(/daily_claims_lease_required/);
  });

  it('запрещает done без времени завершения', async () => {
    await expect(
      pool.query(
        `INSERT INTO daily_claims (processing_day, source, source_slug, status, completed_at)
         VALUES ($1, $2, 'bad-done', 'done', NULL)`,
        [DAY, SOURCE],
      ),
    ).rejects.toThrow(/daily_claims_completed_required/);
  });

  it('первичный ключ не допускает двух заявок на одну игру в сутки', async () => {
    await pool.query(
      `INSERT INTO daily_claims (processing_day, source, source_slug, status, completed_at)
       VALUES ($1, $2, 'dup', 'done', now())`,
      [DAY, SOURCE],
    );

    await expect(
      pool.query(
        `INSERT INTO daily_claims (processing_day, source, source_slug, status, completed_at)
         VALUES ($1, $2, 'dup', 'done', now())`,
        [DAY, SOURCE],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('одна и та же игра может обрабатываться в РАЗНЫЕ дни', async () => {
    await days.ensureDay('2026-09-08');

    await pool.query(
      `INSERT INTO daily_claims (processing_day, source, source_slug, status, completed_at)
       VALUES ($1, $2, 'same-game', 'done', now())`,
      [DAY, SOURCE],
    );
    await expect(
      pool.query(
        `INSERT INTO daily_claims (processing_day, source, source_slug, status, completed_at)
         VALUES ($1, $2, 'same-game', 'done', now())`,
        ['2026-09-08', SOURCE],
      ),
    ).resolves.toBeDefined();
  });
});
