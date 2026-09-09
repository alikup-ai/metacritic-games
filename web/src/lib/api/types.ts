/**
 * Типы ответов API.
 *
 * Соответствуют DTO бэкенда (docs/API.md). Объявлены здесь отдельно, а не
 * импортированы из src/api: фронтенд — самостоятельный workspace со своим
 * tsconfig, и импорт через границу связал бы сборки. Расхождение ловится
 * контрактными тестами.
 *
 * Бизнес-логика бэкенда здесь НЕ повторяется: это только формы данных.
 */

export type ScoreScope = 'platform' | 'overall' | 'overall_fallback' | 'derived';

export interface Pagination {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface Paged<T> {
  readonly items: readonly T[];
  readonly pagination: Pagination;
}

export interface PlatformOption {
  readonly slug: string;
  readonly name: string;
}

export interface GamePlatform {
  readonly slug: string;
  readonly name: string;
  readonly metascore: number | null;
  /** К чему относится оценка: к платформе или к игре целиком (ADR-0008). */
  readonly metascoreScope: ScoreScope;
  readonly userscore: number | null;
  readonly userscoreScope: ScoreScope;
  readonly criticCount: number | null;
  readonly userCount: number | null;
}

export interface GameListItem {
  readonly id: string;
  readonly title: string;
  readonly coverUrl: string | null;
  readonly releaseDate: string | null;
  readonly developer: string | null;
  readonly metascore: number | null;
  readonly userscore: number | null;
}

export interface GameDetail {
  readonly id: string;
  readonly title: string;
  readonly coverUrl: string | null;
  readonly description: string | null;
  readonly videoUrl: string | null;
  readonly releaseDate: string | null;
  readonly genres: readonly string[];
  /** Разработчик и издатель — разные поля; смешивать запрещено (ADR-0003). */
  readonly developer: string | null;
  readonly developerStatus: 'resolved' | 'unknown';
  readonly publishers: readonly string[];
  readonly metascore: number | null;
  readonly userscore: number | null;
  readonly platforms: readonly GamePlatform[];
  /** До пяти похожих игр; пустой массив, если их нет. */
  readonly similar: readonly SimilarGame[];
  readonly sourceUrl: string | null;
  readonly lastUpdatedAt: string;
}

/**
 * Похожая игра.
 *
 * Причины приходят готовыми формулировками: внутренние веса алгоритма
 * наружу не отдаются.
 */
export interface SimilarGame {
  readonly id: string;
  readonly title: string;
  readonly coverUrl: string | null;
  readonly releaseDate: string | null;
  readonly metascore: number | null;
  readonly userscore: number | null;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface AnalysisPoint {
  readonly text: string;
  /** Ссылки на отзывы — часть происхождения вывода, не показываются как текст. */
  readonly evidenceRefs: readonly string[];
}

export interface AnalysisTheme {
  readonly name: string;
  readonly sentiment: 'positive' | 'negative' | 'neutral' | 'mixed';
  readonly description: string;
  readonly evidenceRefs: readonly string[];
}

export interface Analysis {
  readonly status: 'ok' | 'insufficient_reviews' | 'failed';
  readonly platformSlug: string;
  readonly summary: string | null;
  readonly liked: readonly AnalysisPoint[];
  readonly disliked: readonly AnalysisPoint[];
  readonly themes: readonly AnalysisTheme[];
  readonly confidence: 'low' | 'medium' | 'high' | null;
  /** Поля полноты приходят из БД и на фронтенде не пересчитываются. */
  readonly analyzedCount: number;
  readonly totalAvailable: number | null;
  readonly coverage: 'all_reviews' | 'sample' | null;
  readonly snapshotCompleteness: 'complete' | 'partial' | 'incomplete' | null;
  readonly model: string;
  readonly promptVersion: string;
  readonly analyzedAt: string;
}

export interface GameAnalysis {
  readonly gameId: string;
  /** null означает «анализа нет», а не «мнений нет». */
  readonly critic: Analysis | null;
  readonly user: Analysis | null;
}

export interface Review {
  readonly id: string;
  readonly kind: 'critic' | 'user';
  readonly platformSlug: string;
  readonly score: number | null;
  /** Недоверенный текст из внешнего источника. Только как текст. */
  readonly quote: string;
  readonly author: string | null;
  readonly reviewUrl: string | null;
  readonly reviewDate: string | null;
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly details?: { field?: string; allowed?: readonly string[] };
  };
}

export const SORT_FIELDS = ['metascore', 'userscore', 'releaseDate', 'title'] as const;
export type SortField = (typeof SORT_FIELDS)[number];

export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

// ============================================================================
// Мониторинг
// ============================================================================

export interface WorkerStatus {
  readonly name: string;
  /** Фактические состояния из API; 'stalled' выводится интерфейсом. */
  readonly status: 'idle' | 'running';
  readonly lastHeartbeat: string | null;
  readonly currentRunId: string | null;
  readonly processed: number;
  readonly failed: number;
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'skipped' | 'blocked';

export interface RunListItem {
  readonly id: string;
  readonly trigger: 'cron' | 'manual';
  readonly status: RunStatus;
  readonly processingDay: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly processed: number;
  readonly failed: number;
}

export interface RunStage {
  readonly stage: string;
  readonly done: number;
  readonly failed: number;
  readonly skipped: number;
  readonly pending: number;
}

export interface RunDetail extends RunListItem {
  readonly source: string | null;
  readonly planned: number;
  readonly claimed: number;
  readonly succeeded: number;
  readonly partial: number;
  readonly skipped: number;
  readonly pagesScanned: number;
  readonly errorSummary: string | null;
  readonly stages: readonly RunStage[];
}

/** Итог ручного запуска. */
export interface RunTriggerResult {
  readonly runId: string | null;
  readonly outcome: 'completed' | 'failed' | 'skipped';
  readonly processingDay: string;
  readonly claimed: number;
  readonly processed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly stopReason: string | null;
}

// ============================================================================
// Видеообзоры
// ============================================================================

export interface VideoInsight {
  /** 'none' — обогащение ещё не выполнялось. */
  readonly status: 'ok' | 'failed' | 'skipped' | 'quota_exceeded' | 'none';
  readonly reason: string | null;

  readonly videoId: string | null;
  readonly videoUrl: string | null;
  readonly videoTitle: string | null;
  readonly channelTitle: string | null;
  readonly viewCount: number | null;
  readonly publishedAt: string | null;
  readonly durationSeconds: number | null;

  readonly transcriptSource:
    | 'official'
    | 'auto'
    | 'external_captions'
    | 'external_asr'
    | 'metadata_only'
    | 'none';
  readonly summary: string | null;
  readonly liked: readonly string[];
  readonly disliked: readonly string[];
  readonly themes: readonly string[];
  readonly conclusion: string | null;

  readonly model: string | null;
  readonly analyzedAt: string | null;
}
