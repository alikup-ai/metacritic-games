import { silentLogger, type Logger } from '../../../shared/logging/logger.js';
import type { Transcript } from '../domain/video.js';
import { isVideoError, type TranscriptPort } from '../domain/video-ports.js';

/**
 * Цепочка поставщиков расшифровки.
 *
 * Сам реализует TranscriptPort, поэтому слой application не знает, что
 * источников несколько: для него это обычный поставщик.
 *
 * Порядок задаётся при сборке. Первый успех прекращает перебор — так
 * бесплатный источник пробуется раньше платного.
 */

export interface FallbackTranscriptOptions {
  /** Поставщики в порядке предпочтения. */
  readonly providers: readonly { name: string; provider: TranscriptPort }[];
  readonly logger?: Logger;
}

export class FallbackTranscriptAdapter implements TranscriptPort {
  private readonly logger: Logger;

  constructor(private readonly options: FallbackTranscriptOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  async fetchTranscript(params: {
    videoId: string;
    signal?: AbortSignal;
  }): Promise<Transcript | null> {
    for (const { name, provider } of this.options.providers) {
      try {
        const transcript = await provider.fetchTranscript(params);

        if (transcript !== null && transcript.text.trim().length > 0) {
          this.logger.info('Расшифровка получена', {
            operation: 'transcript_fallback',
            videoId: params.videoId,
            provider: name,
            source: transcript.source,
          });
          return transcript;
        }

        // Поставщик отработал, но расшифровки у него нет — пробуем
        // следующий. Это штатный исход, а не сбой.
        this.logger.info('Поставщик не дал расшифровку', {
          operation: 'transcript_fallback',
          videoId: params.videoId,
          provider: name,
          reason: 'unavailable',
        });
      } catch (error) {
        // Сбой одного поставщика не отменяет остальных: цепочка
        // существует именно ради этого.
        this.logger.warn('Поставщик расшифровки отказал', {
          operation: 'transcript_fallback',
          videoId: params.videoId,
          provider: name,
          // Только категория: текст ошибки может нести лишние сведения
          errorCategory: isVideoError(error) ? error.category : 'unknown',
        });
      }
    }

    // Ни один источник не дал расшифровки — прежнее поведение
    return null;
  }
}
