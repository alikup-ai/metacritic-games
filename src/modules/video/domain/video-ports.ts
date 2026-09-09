import type {
  Transcript,
  VideoAnalysisContent,
  VideoCandidate,
  VideoInsight,
} from './video.js';

/**
 * Порты модуля видео.
 *
 * Объявлены в domain, реализуются в infrastructure (ADR-0001).
 * Слой application не знает ни про YouTube, ни про поставщика
 * транскриптов, ни про шлюз модели.
 */

/** Категория сбоя внешнего сервиса. */
export type VideoErrorCategory =
  | 'quota_exceeded'
  | 'not_found'
  | 'unavailable'
  | 'timeout'
  | 'client_error'
  | 'disabled';

/**
 * Сбой работы с видео.
 *
 * `quota_exceeded` отделён намеренно: исчерпание квоты требует мягкого
 * отключения функции, а не повторных попыток (ADR-0005).
 */
export class VideoError extends Error {
  constructor(
    readonly category: VideoErrorCategory,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'VideoError';
  }

  /** Имеет ли смысл повторить позже. */
  get retryable(): boolean {
    return this.category === 'unavailable' || this.category === 'timeout';
  }
}

export function isVideoError(error: unknown): error is VideoError {
  return error instanceof VideoError;
}

/** Поиск роликов по игре. */
export interface VideoSearchPort {
  searchVideos(params: {
    gameTitle: string;
    maxResults: number;
    signal?: AbortSignal;
  }): Promise<readonly VideoCandidate[]>;

  /**
   * Языки доступных дорожек субтитров.
   *
   * Нужен, чтобы не гадать язык: у ролика могут быть субтитры только на
   * немецком, и слепой перебор 'en'/'ru' их не нашёл бы.
   *
   * Пустой массив означает, что дорожек нет либо источник их не сообщил.
   */
  listCaptionLanguages(params: {
    videoId: string;
    signal?: AbortSignal;
  }): Promise<readonly string[]>;
}

/**
 * Получение расшифровки речи.
 *
 * Отсутствие субтитров — штатный исход, а не ошибка: возвращается null.
 * Обход ограничений сервиса недопустим.
 */
export interface TranscriptPort {
  fetchTranscript(params: {
    videoId: string;
    signal?: AbortSignal;
  }): Promise<Transcript | null>;
}

/** Разбор расшифровки моделью. */
export interface VideoAnalysisPort {
  /** Модель из конфигурации — входит в ключ идемпотентности. */
  readonly model: string;

  analyzeTranscript(params: {
    gameTitle: string;
    videoTitle: string;
    channelTitle: string;
    transcript: string;
    promptVersion: string;
    maxOutputTokens: number;
    signal?: AbortSignal;
  }): Promise<VideoAnalysisContent>;
}

export interface VideoInsightRepository {
  find(gameId: string): Promise<VideoInsight | null>;
  save(insight: VideoInsight): Promise<void>;
}
