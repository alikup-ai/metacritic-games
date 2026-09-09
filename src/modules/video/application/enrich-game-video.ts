import {
  selectBestVideo,
  type VideoInsight,
  type VideoSelectionLimits,
} from '../domain/video.js';
import {
  isVideoError,
  type TranscriptPort,
  type VideoAnalysisPort,
  type VideoInsightRepository,
  type VideoSearchPort,
} from '../domain/video-ports.js';

/**
 * Обогащение игры видеообзором.
 *
 * Порядок: поиск роликов → отбор лучшего → расшифровка → разбор.
 *
 * Каждый шаг может не удаться, и это не считается поломкой: функция
 * обогащающая (ADR-0005). Отсутствие субтитров, исчерпание квоты и сбой
 * модели дают разные статусы, но ни один не роняет обработку игры.
 */

export interface EnrichGameVideoDeps {
  readonly search: VideoSearchPort;
  readonly transcripts: TranscriptPort;
  /** null означает, что разбор выключен конфигурацией. */
  readonly analysis: VideoAnalysisPort | null;
  readonly insights: VideoInsightRepository;
  readonly hash: (input: string) => string;
  readonly limits: VideoSelectionLimits;
  readonly maxSearchResults: number;
  readonly promptVersion: string;
  readonly maxOutputTokens: number;
  /** Верхний предел расшифровки; длинные ролики обрезаются. */
  readonly maxTranscriptChars: number;
  readonly now?: () => Date;
}

export interface EnrichGameVideoParams {
  readonly gameId: string;
  readonly gameTitle: string;
  readonly signal?: AbortSignal;
}

export interface EnrichGameVideoResult {
  readonly status: VideoInsight['status'] | 'unchanged';
  readonly videoId: string | null;
  readonly transcriptSource: VideoInsight['transcriptSource'];
}

export class EnrichGameVideoUseCase {
  private readonly now: () => Date;

  constructor(private readonly deps: EnrichGameVideoDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async execute(params: EnrichGameVideoParams): Promise<EnrichGameVideoResult> {
    const base = {
      gameId: params.gameId,
      videoId: null,
      videoUrl: null,
      videoTitle: null,
      channelTitle: null,
      viewCount: null,
      publishedAt: null,
      durationSeconds: null,
      transcriptHash: null,
      summary: null,
      liked: [],
      disliked: [],
      themes: [],
      conclusion: null,
      model: null,
      promptVersion: null,
      lastError: null,
      generatedAt: this.now(),
    } satisfies Omit<VideoInsight, 'status' | 'transcriptSource'>;

    // --- Поиск роликов
    let candidates;
    try {
      candidates = await this.deps.search.searchVideos({
        gameTitle: params.gameTitle,
        maxResults: this.deps.maxSearchResults,
        ...(params.signal ? { signal: params.signal } : {}),
      });
    } catch (error) {
      const category = isVideoError(error) ? error.category : 'unavailable';

      // Исчерпание квоты — не сбой: функция мягко отключается до
      // следующих суток (ADR-0005).
      const status = category === 'quota_exceeded' ? 'quota_exceeded' : 'failed';

      await this.persist({
        ...base,
        status,
        transcriptSource: 'none',
        lastError: category,
      });

      return { status, videoId: null, transcriptSource: 'none' };
    }

    const best = selectBestVideo(params.gameTitle, candidates, this.deps.limits);

    if (!best) {
      await this.persist({
        ...base,
        status: 'skipped',
        transcriptSource: 'none',
        lastError: 'no_relevant_video',
      });
      return { status: 'skipped', videoId: null, transcriptSource: 'none' };
    }

    const video = best.candidate;
    const withVideo = {
      ...base,
      videoId: video.videoId,
      videoUrl: video.url,
      videoTitle: video.title,
      channelTitle: video.channelTitle,
      viewCount: video.viewCount,
      publishedAt: video.publishedAt,
      durationSeconds: video.durationSeconds,
    };

    // --- Расшифровка речи
    let transcript;
    try {
      transcript = await this.deps.transcripts.fetchTranscript({
        videoId: video.videoId,
        ...(params.signal ? { signal: params.signal } : {}),
      });
    } catch (error) {
      // Ссылка на ролик сохраняется: она полезна и без разбора
      await this.persist({
        ...withVideo,
        status: 'skipped',
        transcriptSource: 'none',
        lastError: isVideoError(error) ? error.category : 'transcript_unavailable',
      });
      return { status: 'skipped', videoId: video.videoId, transcriptSource: 'none' };
    }

    if (!transcript || transcript.text.trim().length === 0) {
      await this.persist({
        ...withVideo,
        status: 'skipped',
        transcriptSource: 'metadata_only',
        lastError: 'transcript_unavailable',
      });
      return {
        status: 'skipped',
        videoId: video.videoId,
        transcriptSource: 'metadata_only',
      };
    }

    // --- Идемпотентность: тот же ролик с той же расшифровкой
    const text = transcript.text.slice(0, this.deps.maxTranscriptChars);
    const transcriptHash = this.deps.hash(
      // Модель и версия промпта входят в ключ: их смена меняет результат
      `${video.videoId}\n${this.deps.analysis?.model ?? ''}\n${this.deps.promptVersion}\n${text}`,
    );

    const existing = await this.deps.insights.find(params.gameId);
    if (
      existing &&
      existing.status === 'ok' &&
      existing.transcriptHash === transcriptHash
    ) {
      return {
        status: 'unchanged',
        videoId: video.videoId,
        transcriptSource: existing.transcriptSource,
      };
    }

    // --- Разбор моделью
    if (!this.deps.analysis) {
      await this.persist({
        ...withVideo,
        status: 'skipped',
        transcriptSource: transcript.source,
        transcriptHash,
        lastError: 'analysis_disabled',
      });
      return {
        status: 'skipped',
        videoId: video.videoId,
        transcriptSource: transcript.source,
      };
    }

    try {
      const content = await this.deps.analysis.analyzeTranscript({
        gameTitle: params.gameTitle,
        videoTitle: video.title,
        channelTitle: video.channelTitle,
        transcript: text,
        promptVersion: this.deps.promptVersion,
        maxOutputTokens: this.deps.maxOutputTokens,
        ...(params.signal ? { signal: params.signal } : {}),
      });

      await this.persist({
        ...withVideo,
        status: 'ok',
        transcriptSource: transcript.source,
        transcriptHash,
        summary: content.summary,
        liked: content.liked,
        disliked: content.disliked,
        themes: content.themes,
        conclusion: content.conclusion,
        model: this.deps.analysis.model,
        promptVersion: this.deps.promptVersion,
      });

      return {
        status: 'ok',
        videoId: video.videoId,
        transcriptSource: transcript.source,
      };
    } catch (error) {
      // Сбой разбора не отменяет найденный ролик: он остаётся полезен
      await this.persist({
        ...withVideo,
        status: 'failed',
        transcriptSource: transcript.source,
        // Отпечаток не сохраняется: иначе разовый сбой закрепился бы
        // навсегда и повторная попытка не выполнилась бы
        transcriptHash: null,
        lastError: isVideoError(error) ? error.category : 'analysis_failed',
      });

      return {
        status: 'failed',
        videoId: video.videoId,
        transcriptSource: transcript.source,
      };
    }
  }

  /** Сохранение не должно ронять обработку игры. */
  private async persist(insight: VideoInsight): Promise<void> {
    await this.deps.insights.save(insight).catch(() => undefined);
  }
}
