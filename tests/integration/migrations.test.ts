import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbPool } from '../../src/shared/db/pool.js';
import { getAppliedMigrations, runMigrations } from '../../src/shared/db/migrate.js';
import { tryAcquireLock } from '../../src/shared/db/advisory-lock.js';
import { createTestPool, setupSchema } from './helpers.js';

let pool: DbPool;

beforeAll(async () => {
  pool = createTestPool();
  await setupSchema(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('Миграции', () => {
  it('применяет все файлы миграций', async () => {
    const applied = await getAppliedMigrations(pool);
    const names = applied.map((a) => a.name);
    expect(names).toContain('001_initial_schema.sql');
    expect(names).toContain('002_enrichment.sql');
    expect(names).toContain('003_optional_pgvector.sql');
  });

  it('идемпотентны: повторный запуск не применяет ничего заново', async () => {
    const applied = await runMigrations(pool);
    expect(applied).toHaveLength(0);
  });

  it('создаёт все требуемые таблицы', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const tables = rows.map((r) => r.table_name);

    for (const expected of [
      'games',
      'game_platforms',
      'processing_days',
      'daily_claims',
      'runs',
      'run_events',
      'review_snapshots',
      'review_summaries',
      'similar_games',
      'video_insights',
    ]) {
      expect(tables).toContain(expected);
    }
  });

  it('создаёт обязательные расширения', async () => {
    const { rows } = await pool.query<{ extname: string }>(
      `SELECT extname FROM pg_extension`,
    );
    const names = rows.map((r) => r.extname);
    expect(names).toContain('pgcrypto');
    expect(names).toContain('pg_trgm');
  });

  it('НЕ падает при отсутствии pgvector — это штатный режим (ADR-0009)', async () => {
    // Миграции уже применились выше. Проверяем, что таблица эмбеддингов
    // создаётся только при наличии расширения, а её отсутствие — не ошибка.
    const { rows: ext } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_extension WHERE extname = 'vector'`,
    );
    const { rows: tbl } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.tables
       WHERE table_schema='public' AND table_name='game_embeddings'`,
    );

    if (ext[0]?.count === '1') {
      expect(tbl[0]?.count).toBe('1');
    } else {
      // Расширения нет — таблицы тоже нет, и миграция прошла успешно
      expect(tbl[0]?.count).toBe('0');
    }
  });

  it('создаёт ключевой индекс для reaper', async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'daily_claims' AND indexname = 'daily_claims_lease_idx'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('создаёт trigram-индекс для поиска по названию', async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'games' AND indexname = 'games_title_trgm_idx'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('первичный ключ daily_claims обеспечивает идемпотентность', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
       WHERE tc.table_name = 'daily_claims' AND tc.constraint_type = 'PRIMARY KEY'
       ORDER BY kcu.ordinal_position`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'processing_day',
      'source',
      'source_slug',
    ]);
  });
});

describe('Advisory lock — не более одного запуска', () => {
  it('захватывает и освобождает блокировку', async () => {
    const lock = await tryAcquireLock(pool);
    expect(lock).not.toBeNull();
    await lock!.release();
  });

  it('второй захват не проходит, пока блокировка занята', async () => {
    const first = await tryAcquireLock(pool);
    expect(first).not.toBeNull();

    const second = await tryAcquireLock(pool);
    expect(second).toBeNull(); // конкурирующий запуск должен получить 'skipped'

    await first!.release();

    const third = await tryAcquireLock(pool);
    expect(third).not.toBeNull();
    await third!.release();
  });

  it('повторное освобождение безопасно', async () => {
    const lock = await tryAcquireLock(pool);
    await lock!.release();
    await expect(lock!.release()).resolves.toBeUndefined();
  });
});
