import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../config/index.js';
import { createPool, type DbPool } from './pool.js';

/**
 * Раннер миграций.
 *
 * Свойства, важные для корректности:
 * - каждая миграция выполняется в транзакции (частично применённая миграция
 *   не оставляет схему в промежуточном состоянии);
 * - применение защищено advisory lock — параллельный старт двух инстансов
 *   не приводит к гонке миграций;
 * - применённые миграции фиксируются в schema_migrations и не повторяются.
 */

const MIGRATIONS_LOCK_ID = 4_820_100_001;

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '..', '..', '..', 'migrations');

export interface MigrationRecord {
  name: string;
  appliedAt: Date;
}

async function ensureMigrationsTable(pool: DbPool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

export async function getAppliedMigrations(pool: DbPool): Promise<MigrationRecord[]> {
  await ensureMigrationsTable(pool);
  const { rows } = await pool.query<{ name: string; applied_at: Date }>(
    'SELECT name, applied_at FROM schema_migrations ORDER BY name',
  );
  return rows.map((r) => ({ name: r.name, appliedAt: r.applied_at }));
}

export async function runMigrations(pool: DbPool): Promise<string[]> {
  // Блокировка берётся ПЕРВОЙ, до создания служебной таблицы.
  //
  // Иначе два инстанса одновременно выполняют CREATE TABLE, и PostgreSQL
  // отвергает второй с ошибкой уникальности pg_type_typname_nsp_index:
  // сам CREATE TABLE IF NOT EXISTS не атомарен относительно параллельного
  // создания того же типа.
  await pool.query('SELECT pg_advisory_lock($1)', [MIGRATIONS_LOCK_ID]);

  const applied: string[] = [];
  try {
    await ensureMigrationsTable(pool);

    const { rows } = await pool.query<{ name: string }>(
      'SELECT name FROM schema_migrations',
    );
    const done = new Set(rows.map((r) => r.name));
    const files = await listMigrationFiles();

    for (const file of files) {
      if (done.has(file)) continue;

      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        console.log(`[migrate] применена: ${file}`);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Миграция ${file} не применена: ${message}`);
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.query('SELECT pg_advisory_unlock($1)', [MIGRATIONS_LOCK_ID]);
  }

  return applied;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const pool = createPool(loadConfig());

  try {
    if (command === 'up') {
      const applied = await runMigrations(pool);
      console.log(
        applied.length === 0
          ? '[migrate] новых миграций нет'
          : `[migrate] применено миграций: ${applied.length}`,
      );
    } else if (command === 'status') {
      const [applied, files] = await Promise.all([
        getAppliedMigrations(pool),
        listMigrationFiles(),
      ]);
      const doneNames = new Set(applied.map((a) => a.name));
      console.log('Статус миграций:');
      for (const file of files) {
        console.log(`  ${doneNames.has(file) ? '[применена]' : '[ожидает]  '} ${file}`);
      }
    } else {
      console.error(`Неизвестная команда: ${command}. Доступно: up | status`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

// Запуск только при прямом вызове файла, не при импорте из тестов.
// pathToFileURL корректно строит file:///C:/... на Windows — ручная склейка
// строки давала file://C:/... и условие никогда не выполнялось.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error('[migrate] ошибка:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
