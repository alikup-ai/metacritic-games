import { loadConfig, redactConfig } from '../shared/config/index.js';
import { createPool } from '../shared/db/pool.js';
import { StructuredLogger } from '../shared/logging/logger.js';
import { startApiServer } from '../api/server.js';
import { buildApiRouter } from './bootstrap/api.js';
import { buildIngestion } from './bootstrap/ingestion.js';
import { runStartupSequence } from './bootstrap/startup.js';

/**
 * Точка входа сервиса.
 *
 * Одна точка входа, две роли (APP_ROLE):
 *   api    — обслуживает HTTP-запросы; обработку не ведёт;
 *   worker — ведёт обработку по расписанию; HTTP не обслуживает;
 *   all    — то и другое в одном процессе (по умолчанию, удобно локально).
 *
 * Разделение ролей позволяет масштабировать и перезапускать их отдельно,
 * не заводя второй проект: код и сборка общие.
 *
 * Порядок: конфигурация → БД → миграции и восстановление → сборка
 * конвейера → выбранная роль.
 */

type AppRole = 'api' | 'worker' | 'all';

function resolveRole(value: string | undefined): AppRole {
  if (value === 'api' || value === 'worker' || value === 'all') return value;
  return 'all';
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new StructuredLogger({ level: 'info' });
  const role = resolveRole(process.env.APP_ROLE);

  // В лог уходит только безопасное представление: ключи и строка
  // подключения замаскированы.
  logger.info('Запуск сервиса', {
    operation: 'startup',
    role,
    config: redactConfig(config),
  });

  const pool = createPool(config);

  const startup = await runStartupSequence(pool, config);
  logger.info('Стартовая последовательность выполнена', {
    operation: 'startup',
    migrationsApplied: startup.migrationsApplied.length,
    runsRecovered: startup.recovery.recovered.length,
    runsSkippedActive: startup.recovery.skippedActive,
  });

  const ingestion = buildIngestion(pool, config, logger);

  // HTTP поднимается в ролях api и all. В роли worker он не нужен:
  // ручной запуск идёт через экземпляр api, а конвейер у них общий.
  let server: Awaited<ReturnType<typeof startApiServer>> | null = null;

  if (role === 'api' || role === 'all') {
    const router = buildApiRouter({
      pool,
      config,
      logger,
      runDailyProcessing: ingestion.runDailyProcessing,
    });

    server = await startApiServer({
      router,
      logger,
      port: config.apiPort,
      host: config.apiHost,
    });
  }

  // Планировщик работает только в ролях worker и all: иначе несколько
  // экземпляров api начали бы обработку одновременно. Блокировка это
  // предотвратила бы, но лишние попытки ни к чему.
  const schedulerActive =
    config.schedulerEnabled && (role === 'worker' || role === 'all');

  if (schedulerActive) {
    ingestion.scheduler.start();
    logger.info('Планировщик включён', {
      operation: 'startup',
      role,
      intervalMinutes: config.schedulerIntervalMinutes,
    });
  } else if (role === 'worker') {
    logger.warn('Роль worker выбрана, но планировщик выключен конфигурацией', {
      operation: 'startup',
    });
  }

  /**
   * Корректное завершение.
   *
   * Планировщик останавливается первым, затем сервер перестаёт принимать
   * соединения и лишь потом закрывается пул: иначе текущие запросы
   * потеряли бы подключение к базе на полпути.
   */
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('Получен сигнал завершения', { operation: 'shutdown', signal });

    try {
      if (schedulerActive) await ingestion.scheduler.stop();
      if (server) await server.close();
      await pool.end();
      logger.info('Сервис остановлен', { operation: 'shutdown' });
      process.exit(0);
    } catch (error) {
      logger.error('Ошибка при завершении', {
        operation: 'shutdown',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // Логгер может быть ещё не создан, поэтому пишем напрямую.
  // Сообщение об ошибке конфигурации не содержит значений (loadConfig).
  console.error('Не удалось запустить сервис:', error instanceof Error ? error.message : error);
  process.exit(1);
});
