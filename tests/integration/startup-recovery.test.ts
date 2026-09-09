import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbPool } from '../../src/shared/db/pool.js';
import { PostgresRunRepository } from '../../src/modules/monitoring/infrastructure/postgres-run-repository.js';
import { recoverOrphanedRuns } from '../../src/modules/monitoring/application/recover-orphaned-runs.js';
import {
  isLockHeld,
  STARTUP_RECOVERY_LOCK_ID,
  withLock,
} from '../../src/shared/db/advisory-lock.js';
import { createTestPool, setupSchema, truncateAll, TEST_DATABASE_URL } from './helpers.js';

/**
 * Восстановление осиротевших запусков (ADR-0010).
 *
 * Проверяются четыре сценария из требований: обычный старт, осиротевший
 * запуск, параллельный старт, повторное восстановление.
 */

const INGESTION_LOCK = 4_820_100_002;

let pool: DbPool;
let runs: PostgresRunRepository;

function makeDeps(overrides: Partial<Parameters<typeof recoverOrphanedRuns>[0]> = {}) {
  return {
    runs,
    isLockHeld: (lockKey: number) => isLockHeld(pool, lockKey),
    withRecoveryLock: async <T>(fn: () => Promise<T>): Promise<T | null> => {
      const outcome = await withLock(pool, fn, STARTUP_RECOVERY_LOCK_ID);
      return outcome.acquired ? outcome.result : null;
    },
    heartbeatTimeoutMinutes: 15,
    ...overrides,
  };
}

beforeAll(async () => {
  pool = createTestPool();
  await setupSchema(pool);
  runs = new PostgresRunRepository(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
});

describe('Сценарий 1 — обычный старт', () => {
  it('при отсутствии запусков ничего не восстанавливает', async () => {
    const result = await recoverOrphanedRuns(makeDeps());
    expect(result.recovered).toHaveLength(0);
    expect(result.skippedActive).toBe(0);
  });

  it('не трогает корректно завершённые запуски', async () => {
    const run = await runs.start('cron', { lockKey: INGESTION_LOCK });
    await runs.finish({ runId: run.id, status: 'completed' });

    const result = await recoverOrphanedRuns(makeDeps());
    expect(result.recovered).toHaveLength(0);

    const after = await runs.findById(run.id);
    expect(after?.status).toBe('completed');
    expect(after?.recoveredAt).toBeNull();
  });

  it('НЕ трогает живой запуск, удерживающий advisory lock', async () => {
    // Отдельное соединение имитирует работающий процесс
    const worker = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await worker.connect();
    await worker.query('SELECT pg_try_advisory_lock($1)', [INGESTION_LOCK]);

    const run = await runs.start('cron', { lockKey: INGESTION_LOCK });

    try {
      const result = await recoverOrphanedRuns(makeDeps());

      // Ключевое требование: не конфликтовать с реально работающим run
      expect(result.recovered).toHaveLength(0);
      expect(result.skippedActive).toBe(1);

      const after = await runs.findById(run.id);
      expect(after?.status).toBe('running');
    } finally {
      await worker.end();
    }
  });

  it('НЕ трогает долгий, но живой запуск (старый started_at сам по себе не признак)', async () => {
    const worker = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await worker.connect();
    await worker.query('SELECT pg_try_advisory_lock($1)', [INGESTION_LOCK]);

    const run = await runs.start('cron', { lockKey: INGESTION_LOCK });
    // Запуск идёт уже 6 часов, но процесс жив
    await pool.query(
      `UPDATE runs SET started_at = now() - interval '6 hours',
                       heartbeat_at = now() - interval '6 hours'
       WHERE id = $1`,
      [run.id],
    );

    try {
      const result = await recoverOrphanedRuns(makeDeps());
      // Критерий «running дольше N минут» ошибочно убил бы этот запуск
      expect(result.recovered).toHaveLength(0);

      const after = await runs.findById(run.id);
      expect(after?.status).toBe('running');
    } finally {
      await worker.end();
    }
  });
});

describe('Сценарий 2 — осиротевший запуск', () => {
  it('восстанавливает запуск, чей advisory lock не удерживается', async () => {
    // Имитация падения: lock_key записан, но блокировку никто не держит
    const run = await runs.start('cron', {
      lockKey: INGESTION_LOCK,
      ownerId: 'host:1234',
    });

    const result = await recoverOrphanedRuns(makeDeps());

    expect(result.recovered).toHaveLength(1);
    expect(result.recovered[0]?.runId).toBe(run.id);

    const after = await runs.findById(run.id);
    // Именно failed: работа не была доведена до конца
    expect(after?.status).toBe('failed');
    expect(after?.finishedAt).not.toBeNull();
    expect(after?.recoveredAt).not.toBeNull();
    expect(after?.recoveryReason).toContain('advisory lock');
  });

  it('сохраняет причину восстановления в run_events', async () => {
    const run = await runs.start('cron', {
      lockKey: INGESTION_LOCK,
      ownerId: 'host:4321',
    });

    await recoverOrphanedRuns(makeDeps());

    const events = await runs.listEvents({ runId: run.id, limit: 50 });
    const recoveryEvent = events.find((e) => e.stage === 'startup_recovery');

    expect(recoveryEvent).toBeDefined();
    expect(recoveryEvent?.level).toBe('warn');
    expect(recoveryEvent?.message).toContain('восстановлен');
    expect(recoveryEvent?.payload?.previousStatus).toBe('running');
    expect(recoveryEvent?.payload?.newStatus).toBe('failed');
    expect(recoveryEvent?.payload?.ownerId).toBe('host:4321');
  });

  it('освобождает уникальный индекс, позволяя запустить новый run', async () => {
    await runs.start('cron', { lockKey: INGESTION_LOCK });

    // Пока осиротевший запуск числится running, индекс блокирует новый
    await expect(runs.start('manual', { lockKey: INGESTION_LOCK })).rejects.toThrow(
      /duplicate key|runs_single_active_idx/,
    );

    await recoverOrphanedRuns(makeDeps());

    // После восстановления новый запуск создаётся
    const fresh = await runs.start('manual', { lockKey: INGESTION_LOCK });
    expect(fresh.status).toBe('running');
  });

  it('восстанавливает по heartbeat запуск без lock_key (запасной критерий)', async () => {
    const run = await runs.start('cron'); // lock_key не задан
    await pool.query(
      `UPDATE runs SET heartbeat_at = now() - interval '30 minutes' WHERE id = $1`,
      [run.id],
    );

    const result = await recoverOrphanedRuns(makeDeps());

    expect(result.recovered).toHaveLength(1);
    const after = await runs.findById(run.id);
    expect(after?.status).toBe('failed');
    expect(after?.recoveryReason).toContain('отметка живости');
  });

  it('НЕ восстанавливает запуск без lock_key со свежим heartbeat', async () => {
    const run = await runs.start('cron');
    // heartbeat только что обновлён — процесс, вероятно, жив
    await runs.touchHeartbeat(run.id);

    const result = await recoverOrphanedRuns(makeDeps());

    expect(result.recovered).toHaveLength(0);
    const after = await runs.findById(run.id);
    expect(after?.status).toBe('running');
  });

  it('не трогает daily_claims — ими занимается reaper (разделение механизмов)', async () => {
    await pool.query(
      `INSERT INTO processing_days (day) VALUES ('2026-09-07')
       ON CONFLICT DO NOTHING`,
    );
    const run = await runs.start('cron', { lockKey: INGESTION_LOCK });
    await pool.query(
      `INSERT INTO daily_claims
         (processing_day, source, source_slug, run_id, status, lease_until, attempts)
       VALUES ('2026-09-07', 'metacritic', 'x', $1, 'claimed', now() + interval '10 min', 1)`,
      [run.id],
    );

    await recoverOrphanedRuns(makeDeps());

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM daily_claims WHERE source_slug = 'x'`,
    );
    // Заявка осталась нетронутой: её судьбу решает reaper по истечении lease
    expect(rows[0]?.status).toBe('claimed');
  });
});

describe('Сценарий 3 — параллельный старт', () => {
  it('два процесса восстанавливают запуск ровно один раз', async () => {
    const run = await runs.start('cron', { lockKey: INGESTION_LOCK });

    const [a, b] = await Promise.all([
      recoverOrphanedRuns(makeDeps()),
      recoverOrphanedRuns(makeDeps()),
    ]);

    const total = a.recovered.length + b.recovered.length;
    expect(total).toBe(1);

    const after = await runs.findById(run.id);
    expect(after?.status).toBe('failed');
  });

  it('событие восстановления записывается ровно один раз', async () => {
    const run = await runs.start('cron', { lockKey: INGESTION_LOCK });

    await Promise.all([
      recoverOrphanedRuns(makeDeps()),
      recoverOrphanedRuns(makeDeps()),
      recoverOrphanedRuns(makeDeps()),
    ]);

    const events = await runs.listEvents({ runId: run.id, limit: 100 });
    const recoveryEvents = events.filter((e) => e.stage === 'startup_recovery');
    // Дублирующих записей быть не должно
    expect(recoveryEvents).toHaveLength(1);
  });

  it('процесс, не взявший блокировку recovery, возвращает пустой результат', async () => {
    await runs.start('cron', { lockKey: INGESTION_LOCK });

    // Занимаем блокировку recovery сторонним соединением
    const blocker = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await blocker.connect();
    await blocker.query('SELECT pg_advisory_lock($1)', [STARTUP_RECOVERY_LOCK_ID]);

    try {
      const result = await recoverOrphanedRuns(makeDeps());
      // Не смогли взять блокировку — восстановление делает другой процесс
      expect(result.recovered).toHaveLength(0);
    } finally {
      await blocker.query('SELECT pg_advisory_unlock($1)', [STARTUP_RECOVERY_LOCK_ID]);
      await blocker.end();
    }
  });
});

describe('Сценарий 4 — повторное восстановление (идемпотентность)', () => {
  it('повторный вызов не выполняет действий', async () => {
    await runs.start('cron', { lockKey: INGESTION_LOCK });

    const first = await recoverOrphanedRuns(makeDeps());
    expect(first.recovered).toHaveLength(1);

    const second = await recoverOrphanedRuns(makeDeps());
    expect(second.recovered).toHaveLength(0);

    const third = await recoverOrphanedRuns(makeDeps());
    expect(third.recovered).toHaveLength(0);
  });

  it('не порождает дублирующих событий при многократных вызовах', async () => {
    const run = await runs.start('cron', { lockKey: INGESTION_LOCK });

    await recoverOrphanedRuns(makeDeps());
    await recoverOrphanedRuns(makeDeps());
    await recoverOrphanedRuns(makeDeps());

    const events = await runs.listEvents({ runId: run.id, limit: 100 });
    expect(events.filter((e) => e.stage === 'startup_recovery')).toHaveLength(1);
  });

  it('markRecovered возвращает false для уже восстановленного запуска', async () => {
    const run = await runs.start('cron', { lockKey: INGESTION_LOCK });

    const first = await runs.markRecovered({ runId: run.id, reason: 'первый' });
    expect(first).toBe(true);

    const second = await runs.markRecovered({ runId: run.id, reason: 'второй' });
    expect(second).toBe(false);

    const after = await runs.findById(run.id);
    // Причина от первого вызова не перезаписана
    expect(after?.recoveryReason).toBe('первый');
  });
});

describe('isLockHeld — основной критерий живости', () => {
  it('видит удерживаемую блокировку и её исчезновение после обрыва', async () => {
    const holder = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await holder.connect();
    await holder.query('SELECT pg_try_advisory_lock($1)', [INGESTION_LOCK]);

    expect(await isLockHeld(pool, INGESTION_LOCK)).toBe(true);

    // Имитация падения процесса: обрыв без явного unlock
    await holder.end();
    await new Promise((r) => setTimeout(r, 300));

    // PostgreSQL снял блокировку сам — это и есть признак смерти владельца
    expect(await isLockHeld(pool, INGESTION_LOCK)).toBe(false);
  });

  it('корректно раскладывает 64-битный ключ (objid имеет тип uint32)', async () => {
    // Наивное сравнение с objid упало бы с "value out of range for type oid"
    await expect(isLockHeld(pool, INGESTION_LOCK)).resolves.toBe(false);
    await expect(isLockHeld(pool, STARTUP_RECOVERY_LOCK_ID)).resolves.toBe(false);
  });
});

describe('touchHeartbeat', () => {
  it('обновляет отметку живости работающего запуска', async () => {
    const run = await runs.start('cron', { lockKey: INGESTION_LOCK });
    await pool.query(
      `UPDATE runs SET heartbeat_at = now() - interval '5 minutes' WHERE id = $1`,
      [run.id],
    );
    const before = await runs.findById(run.id);

    await runs.touchHeartbeat(run.id);

    const after = await runs.findById(run.id);
    expect(after!.heartbeatAt.getTime()).toBeGreaterThan(before!.heartbeatAt.getTime());
  });

  it('не воскрешает уже завершённый запуск', async () => {
    const run = await runs.start('cron', { lockKey: INGESTION_LOCK });
    await runs.finish({ runId: run.id, status: 'completed' });

    await runs.touchHeartbeat(run.id);

    const after = await runs.findById(run.id);
    expect(after?.status).toBe('completed');
  });
});
