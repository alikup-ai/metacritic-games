import { silentLogger, type Logger } from '../../../shared/logging/logger.js';
import { pickTranscriptLanguage, type Transcript } from '../domain/video.js';
import { VideoError, type TranscriptPort } from '../domain/video-ports.js';

/**
 * Получение расшифровки речи по общедоступным субтитрам.
 *
 * Используется только открытый механизм субтитров YouTube. Обход
 * ограничений сервиса, CAPTCHA и защитных механизмов не выполняется:
 * отсутствие субтитров — штатный исход, возвращается null.
 */

const TIMEDTEXT_ENDPOINT = 'https://www.youtube.com/api/timedtext';

export interface YouTubeTranscriptOptions {
  readonly timeoutMs: number;
  readonly logger?: Logger;
  readonly fetchImpl?: typeof fetch;
  readonly endpoint?: string;
  /** Порядок предпочитаемых языков субтитров. */
  readonly languages?: readonly string[];
  /**
   * Язык из конфигурации — третий приоритет после en и ru.
   */
  readonly fallbackLanguage?: string | null;
  /**
   * Источник списка доступных дорожек.
   *
   * Без него адаптер перебирает предпочитаемые языки вслепую и не найдёт
   * субтитры на прочих языках: у проверенного ролика доступны только
   * немецкие дорожки.
   */
  readonly captionLanguages?: (params: {
    videoId: string;
    signal?: AbortSignal;
  }) => Promise<readonly string[]>;
}

/** Убирает разметку и служебные вставки из текста субтитров. */
export function extractTranscriptText(xml: string): string {
  const parts: string[] = [];
  const pattern = /<text[^>]*>([\s\S]*?)<\/text>/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const raw = match[1] ?? '';
    const decoded = raw
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
      // Внутри субтитров встречается собственная разметка
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (decoded.length > 0) parts.push(decoded);
  }

  return parts.join(' ');
}

export class YouTubeTranscriptAdapter implements TranscriptPort {
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly languages: readonly string[];

  constructor(private readonly options: YouTubeTranscriptOptions) {
    this.logger = options.logger ?? silentLogger;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.languages = options.languages ?? ['en', 'ru'];
  }

  async fetchTranscript(params: {
    videoId: string;
    signal?: AbortSignal;
  }): Promise<Transcript | null> {
    // Сначала выясняем, какие дорожки есть на самом деле. Слепой перебор
    // предпочитаемых языков пропускал субтитры на прочих языках.
    let languages: readonly string[] = this.languages;

    if (this.options.captionLanguages) {
      const available = await this.options
        .captionLanguages({
          videoId: params.videoId,
          ...(params.signal ? { signal: params.signal } : {}),
        })
        .catch(() => [] as readonly string[]);

      const chosen = pickTranscriptLanguage({
        available,
        preferred: this.languages,
        fallbackLanguage: this.options.fallbackLanguage ?? null,
      });

      // Список получен — пробуем именно его язык; пусто — прежний перебор
      if (chosen !== null) languages = [chosen];
    }

    // Сначала официальные субтитры, затем автоматические: первые точнее
    for (const language of languages) {
      for (const kind of ['official', 'auto'] as const) {
        const text = await this.tryFetch(params.videoId, language, kind, params.signal);

        if (text !== null && text.length > 0) {
          this.logger.info('Расшифровка получена', {
            operation: 'youtube_transcript',
            videoId: params.videoId,
            source: kind,
            language,
            // Сам текст в журнал не пишется
            length: text.length,
          });

          return { source: kind, text, language };
        }
      }
    }

    // Субтитров нет — это не ошибка
    return null;
  }

  private async tryFetch(
    videoId: string,
    language: string,
    kind: 'official' | 'auto',
    signal: AbortSignal | undefined,
  ): Promise<string | null> {
    const url = new URL(this.options.endpoint ?? TIMEDTEXT_ENDPOINT);
    url.searchParams.set('v', videoId);
    url.searchParams.set('lang', language);
    // asr — автоматически распознанная речь
    if (kind === 'auto') url.searchParams.set('kind', 'asr');

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.options.timeoutMs);

    try {
      const response = await this.fetchImpl(url.toString(), {
        signal: signal ?? timeout.signal,
      });

      // Отсутствие субтитров возвращается пустым телом либо 404
      if (!response.ok) return null;

      const xml = await response.text();
      return extractTranscriptText(xml);
    } catch (error) {
      if (timeout.signal.aborted) {
        throw new VideoError('timeout', 'Субтитры не получены вовремя', { cause: error });
      }
      // Сетевой сбой — отсутствие расшифровки, а не поломка обработки
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
