import { z } from 'zod/v4';
import { silentLogger, type Logger } from '../../../shared/logging/logger.js';
import type { VideoCandidate } from '../domain/video.js';
import { VideoError, type VideoSearchPort } from '../domain/video-ports.js';

/**
 * Поиск роликов через YouTube Data API v3.
 *
 * Единственное место, знающее про YouTube: application работает через
 * порт VideoSearchPort.
 *
 * Ключ приходит только из окружения и никогда не попадает ни в журнал,
 * ни в сообщения об ошибках.
 */

const SEARCH_ENDPOINT = 'https://www.googleapis.com/youtube/v3/search';
const VIDEOS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/videos';
const CAPTIONS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/captions';

export interface YouTubeSearchOptions {
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly logger?: Logger;
  /** Подменяется в тестах: реальных обращений к API нет. */
  readonly fetchImpl?: typeof fetch;
  readonly searchEndpoint?: string;
  readonly videosEndpoint?: string;
  readonly captionsEndpoint?: string;
}

/** Ответы разбираются мягко: лишние поля игнорируются. */
const searchResponseSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.object({ videoId: z.string().nullish() }).loose().nullish(),
            snippet: z
              .object({
                title: z.string().nullish(),
                channelTitle: z.string().nullish(),
                publishedAt: z.string().nullish(),
              })
              .loose()
              .nullish(),
          })
          .loose(),
      )
      .nullish(),
  })
  .loose();

/** Список дорожек субтитров; скачивание требует OAuth, перечисление — нет. */
const captionsResponseSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            snippet: z
              .object({
                language: z.string().nullish(),
                trackKind: z.string().nullish(),
              })
              .loose()
              .nullish(),
          })
          .loose(),
      )
      .nullish(),
  })
  .loose();

const videosResponseSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string().nullish(),
            snippet: z
              .object({
                title: z.string().nullish(),
                channelTitle: z.string().nullish(),
                publishedAt: z.string().nullish(),
              })
              .loose()
              .nullish(),
            statistics: z.object({ viewCount: z.string().nullish() }).loose().nullish(),
            contentDetails: z
              .object({
                duration: z.string().nullish(),
                // 'true' | 'false' строкой — есть ли субтитры
                caption: z.string().nullish(),
              })
              .loose()
              .nullish(),
          })
          .loose(),
      )
      .nullish(),
  })
  .loose();

/**
 * Разбирает длительность в формате ISO 8601 (PT1H2M3S).
 *
 * Возвращает null при неразобранном значении: выдуманная длительность
 * исказила бы отбор роликов.
 */
export function parseIsoDuration(value: string | null | undefined): number | null {
  if (!value) return null;

  const match = /^P(?:([\d.]+)D)?T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?$/.exec(value);
  if (!match) return null;

  const [, days, hours, minutes, seconds] = match;
  const total =
    Number(days ?? 0) * 86400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);

  return Number.isFinite(total) ? Math.round(total) : null;
}

export class YouTubeSearchAdapter implements VideoSearchPort {
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: YouTubeSearchOptions) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      // Ключ обязателен и приходит только из окружения
      throw new Error('YOUTUBE_API_KEY не задан: поиск видео недоступен');
    }

    this.logger = options.logger ?? silentLogger;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async searchVideos(params: {
    gameTitle: string;
    maxResults: number;
    signal?: AbortSignal;
  }): Promise<readonly VideoCandidate[]> {
    // Запрос сужается сразу: длинные ролики и только видео.
    // videoDuration=medium|long отсекает Shorts на стороне сервиса.
    const search = new URL(this.options.searchEndpoint ?? SEARCH_ENDPOINT);
    search.searchParams.set('part', 'snippet');
    search.searchParams.set('type', 'video');
    search.searchParams.set('videoDuration', 'medium');
    search.searchParams.set('order', 'viewCount');
    search.searchParams.set('maxResults', String(Math.min(params.maxResults, 50)));
    search.searchParams.set('q', `${params.gameTitle} gameplay review`);
    search.searchParams.set('key', this.options.apiKey);

    const searchBody = await this.request(search, params.signal, searchResponseSchema);

    const ids = (searchBody.items ?? [])
      .map((item) => item.id?.videoId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    if (ids.length === 0) return [];

    // Второй запрос: просмотры и длительность есть только здесь
    const videos = new URL(this.options.videosEndpoint ?? VIDEOS_ENDPOINT);
    videos.searchParams.set('part', 'snippet,statistics,contentDetails');
    videos.searchParams.set('id', ids.join(','));
    videos.searchParams.set('key', this.options.apiKey);

    const videosBody = await this.request(videos, params.signal, videosResponseSchema);

    const candidates: VideoCandidate[] = [];
    for (const item of videosBody.items ?? []) {
      if (!item.id || !item.snippet?.title) continue;

      const views = item.statistics?.viewCount;
      candidates.push({
        videoId: item.id,
        title: item.snippet.title,
        channelTitle: item.snippet.channelTitle ?? 'неизвестный канал',
        url: `https://www.youtube.com/watch?v=${item.id}`,
        publishedAt: item.snippet.publishedAt ?? null,
        viewCount: views !== null && views !== undefined ? Number(views) : null,
        durationSeconds: parseIsoDuration(item.contentDetails?.duration),
        // Поле приходит строкой; null, если источник его не сообщил
        hasCaptions:
          item.contentDetails?.caption === undefined ||
          item.contentDetails?.caption === null
            ? null
            : item.contentDetails.caption === 'true',
      });
    }

    this.logger.info('Поиск видео выполнен', {
      operation: 'youtube_search',
      // Ни ключа, ни полного запроса в журнале нет
      found: candidates.length,
    });

    return candidates;
  }

  async listCaptionLanguages(params: {
    videoId: string;
    signal?: AbortSignal;
  }): Promise<readonly string[]> {
    const url = new URL(this.options.captionsEndpoint ?? CAPTIONS_ENDPOINT);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('videoId', params.videoId);
    url.searchParams.set('key', this.options.apiKey);

    try {
      const body = await this.request(url, params.signal, captionsResponseSchema);

      // Порядок сохраняется: ручные дорожки обычно идут раньше
      const languages: string[] = [];
      for (const item of body.items ?? []) {
        const language = item.snippet?.language;
        if (language && !languages.includes(language)) languages.push(language);
      }
      return languages;
    } catch {
      // Список языков — подсказка, а не обязательное условие: без него
      // остаётся перебор предпочитаемых языков
      return [];
    }
  }

  /** Выполняет запрос и приводит сбои к типизированным категориям. */
  private async request<T>(
    url: URL,
    signal: AbortSignal | undefined,
    schema: z.ZodType<T>,
  ): Promise<T> {
    // Свой таймаут; повторов на этом уровне нет — решение принимает
    // вызывающий, а функция обогащающая и настойчивости не требует.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.options.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        headers: { accept: 'application/json' },
        signal: signal ? anySignal([timeout.signal, signal]) : timeout.signal,
      });
    } catch (error) {
      if (timeout.signal.aborted) {
        throw new VideoError('timeout', 'YouTube не ответил вовремя', { cause: error });
      }
      // Адрес и ключ в сообщение не подставляются
      throw new VideoError('unavailable', 'YouTube недоступен', { cause: error });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      await response.text().catch(() => '');
      throw toYouTubeError(response.status);
    }

    const raw: unknown = await response.json().catch(() => null);
    const parsed = schema.safeParse(raw);

    if (!parsed.success) {
      throw new VideoError('unavailable', 'Неожиданная форма ответа YouTube');
    }

    return parsed.data;
  }
}

/**
 * Сопоставляет код ответа с категорией.
 *
 * 403 у YouTube чаще всего означает исчерпание квоты — это мягкое
 * отключение функции, а не сбой обработки игры (ADR-0005).
 */
export function toYouTubeError(status: number): VideoError {
  if (status === 403) {
    return new VideoError('quota_exceeded', 'Квота YouTube исчерпана');
  }
  if (status === 404) {
    return new VideoError('not_found', 'Ресурс YouTube не найден');
  }
  if (status === 429) {
    return new VideoError('quota_exceeded', 'Превышена частота обращений к YouTube');
  }
  if (status >= 500) {
    return new VideoError('unavailable', `YouTube недоступен (${status})`);
  }
  return new VideoError('client_error', `YouTube отклонил запрос (${status})`);
}

/** AbortSignal.any доступен не везде — есть запасной путь. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const any = (AbortSignal as unknown as {
    any?: (s: AbortSignal[]) => AbortSignal;
  }).any;
  if (typeof any === 'function') return any(signals);

  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}
