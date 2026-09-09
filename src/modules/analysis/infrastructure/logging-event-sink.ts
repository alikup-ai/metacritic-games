import type { AnalysisEvent, AnalysisEventSink } from '../domain/analysis-events.js';
import type { Logger } from '../../../shared/logging/logger.js';

/**
 * Публикует события анализа в структурный лог.
 *
 * События по построению не содержат ни промпта, ни текстов отзывов, ни
 * ответа модели, ни ключа API — только контекст и счётчики
 * (см. analysis-events.ts).
 */
export class LoggingAnalysisEventSink implements AnalysisEventSink {
  constructor(private readonly logger: Logger) {}

  emit(event: AnalysisEvent): void {
    const { type, ...rest } = event;

    switch (type) {
      case 'llm_analysis_failed':
        this.logger.error('Анализ отзывов завершился ошибкой', { event: type, ...rest });
        return;

      case 'llm_analysis_skipped':
        // Пропуск — штатное состояние: совпал вход либо отзывов слишком мало
        this.logger.info('Анализ отзывов пропущен', { event: type, ...rest });
        return;

      default:
        this.logger.info('Событие анализа отзывов', { event: type, ...rest });
    }
  }
}
