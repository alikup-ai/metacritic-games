import { z } from 'zod/v4';
import { silentLogger, type Logger } from '../../../shared/logging/logger.js';
import { parseRetryAfter } from '../../../shared/http/retry-after.js';
import { pickTranscriptLanguage, type Transcript } from '../domain/video.js';
import { VideoError, type TranscriptPort } from '../domain/video-ports.js';

/**
 * Расшифровка через Supadata.
 *
 * Нужен потому, что открытая точка timedtext перестала отдавать данные,
 * а официальный captions.download требует OAuth с правами владельца
 * ролика — для чужих видео он недоступен в принципе.
 *
 * Ключ приходит только из окружения и никогда не попадает ни в журнал,
 * ни в сообщения об ошибках.
 */

const ENDPOINT = 'https://api.supadata.ai/v1/youtube/transcript';

export interface SupadataTranscriptOptions {
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly logger?: Logger;
  /** Подменяется в тестах: реальных обращений к сервису нет. */
  readonly fetchImpl?: typeof fetch;
  readonly endpoint?: string;
  /** Порядок предпочитаемых языков. */
  readonly languages?: readonly string[];
  readonly fallbackLanguage?: string | null;
}

/** Ответ разбирается мягко: лишние поля игнорируются. */
const responseSchema = z
  .object({
    content: z.string().nullish(),
    lang: z.string().nullish(),
    availableLangs: z.array(z.string()).nullish(),
  })
  .loose();

const errorSchema = z
  .object({
    error: z.string().nullish(),
    message: z.string().nullish(),
  })
  .loose();

export class SupadataTranscriptAdapter implements TranscriptPort {
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SupadataTranscriptOptions) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      // Ключ обязателен: без него адаптер создавать нельзя
      throw new Error('SUPADATA_API_KEY не задан: внешняя расшифровка недоступна');
    }

    this.logger = options.logger ?? silentLogger;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetchTranscript(params: {
    videoId: string;
    signal?: AbortSignal;
  }): Promise<Transcript | null> {
    const url = new URL(this.options.endpoint ?? ENDPOINT);
    url.searchParams.set('videoId', params.videoId);
    // Нужен связный текст, а не массив отрезков с таймкодами
    url.searchParams.set('text', 'true');

    // Язык подсказывается, но не навязывается: при отсутствии
    // запрошенного сервис отдаёт первый доступный.
    const preferred = pickTranscriptLanguage({
      available: this.options.languages ?? ['en', 'ru'],
      preferred: this.options.languages ?? ['en', 'ru'],
      fallbackLanguage: this.options.fallbackLanguage ?? null,
    });
    if (preferred) url.searchParams.set('lang', preferred);

    // Свой таймаут; повторов на этом уровне нет — решение принимает
    // вызывающий, а функция обогащающая и настойчивости не требует.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.options.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        headers: {
          // Единственное место, где ключ покидает конфигурацию
          'x-api-key': this.options.apiKey,
          accept: 'application/json',
        },
        signal: params.signal ?? timeout.signal,
      });
    } catch (error) {
      if (timeout.signal.aborted) {
        throw new VideoError('timeout', 'Сервис расшифровки не ответил вовремя', {
          cause: error,
        });
      }
      // Ни ключ, ни адрес в сообщение не подставляются
      throw new VideoError('unavailable', 'Сервис расшифровки недоступен', {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    // 206 — расшифровки нет. Это штатный исход, а не сбой.
    if (response.status === 206) {
      return null;
    }

    if (!response.ok) {
      throw await toSupadataError(response);
    }

    const raw: unknown = await response.json().catch(() => null);
    const parsed = responseSchema.safeParse(raw);

    if (!parsed.success) {
      throw new VideoError('unavailable', 'Неожиданная форма ответа сервиса расшифровки');
    }

    const text = typeof parsed.data.content === 'string' ? parsed.data.content.trim() : '';
    if (text.length === 0) return null;

    this.logger.info('Внешняя расшифровка получена', {
      operation: 'supadata_transcript',
      videoId: params.videoId,
      language: parsed.data.lang ?? null,
      // Сам текст в журнал не пишется
      length: text.length,
    });

    return {
      // Сервис НЕ сообщает, взяты ли субтитры у площадки или речь
      // распознана им самим: в ответе такого поля нет. Выдумывать
      // происхождение нельзя, поэтому используется более осторожное
      // значение — 'external_captions'. Значение 'external_asr'
      // останется незанятым, пока сервис не начнёт различать источник.
      source: 'external_captions',
      text,
      language: parsed.data.lang ?? null,
    };
  }
}

/**
 * Приводит ответ сервиса к типизированной категории.
 *
 * Повторять имеет смысл только временные сбои: неверный ключ и
 * исчерпанный лимит повтором не лечатся.
 */
export async function toSupadataError(response: Response): Promise<VideoError> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = errorSchema.safeParse(body);
  const code = parsed.success ? parsed.data.error : null;

  const status = response.status;

  if (status === 401 || status === 403) {
    // Ключ неверен либо не даёт доступа: повтор не поможет
    return new VideoError('client_error', 'Сервис расшифровки отклонил ключ доступа');
  }

  if (status === 402 || code === 'upgrade-required' || code === 'limit-exceeded') {
    return new VideoError('quota_exceeded', 'Лимит сервиса расшифровки исчерпан');
  }

  if (status === 429) {
    // Задержку сервис сообщает заголовком; функция обогащающая, поэтому
    // попытка откладывается до следующего запуска
    parseRetryAfter(response.headers.get('retry-after'));
    return new VideoError('quota_exceeded', 'Превышена частота обращений к сервису');
  }

  if (status === 404 || code === 'not-found') {
    return new VideoError('not_found', 'Ролик не найден сервисом расшифровки');
  }

  if (status >= 500) {
    return new VideoError('unavailable', `Сбой сервиса расшифровки (${status})`);
  }

  return new VideoError('client_error', `Запрос отклонён сервисом (${status})`);
}
