import type {
  IngestionEvent,
  IngestionEventSink,
} from '../domain/ingestion-events.js';
import type { Logger } from '../../../shared/logging/logger.js';

/**
 * Публикует события ingestion в структурный лог.
 *
 * Логгер сам вычищает чувствительные поля и обрезает длинные строки, поэтому
 * полный HTML и секреты сюда попасть не могут.
 */
export class LoggingIngestionEventSink implements IngestionEventSink {
  constructor(private readonly logger: Logger) {}

  emit(event: IngestionEvent): void {
    const { type, ...rest } = event;

    switch (type) {
      case 'ingestion_failed':
        this.logger.error('Ingestion завершился ошибкой', { event: type, ...rest });
        return;

      case 'userscore_unavailable':
        // Не ошибка: Userscore — обогащение, его отсутствие штатно
        this.logger.warn('Общий Userscore недоступен', { event: type, ...rest });
        return;

      case 'platforms_synchronized': {
        const synced = event;
        if (synced.deactivated > 0 || synced.skippedDeactivation) {
          // Отключение платформ и пропуск отключения — сигналы, за которыми
          // стоит следить: рост может означать поломку парсера
          this.logger.warn('Платформы синхронизированы с отклонениями', {
            event: type,
            ...rest,
          });
          return;
        }
        this.logger.info('Платформы синхронизированы', { event: type, ...rest });
        return;
      }

      default:
        this.logger.info('Событие ingestion', { event: type, ...rest });
    }
  }
}
