/**
 * DTO слоя API.
 *
 * Граница между доменом и внешним миром. Доменные сущности наружу не
 * отдаются: у них своя жизнь, и их изменение не должно ломать клиентов
 * (требование §9 Phase 3A).
 *
 * Здесь нет ни SQL, ни знания о PostgreSQL: только формы данных и чистые
 * функции преобразования.
 */

import type { Game, GamePlatform, ScoreScope } from '../../modules/catalog/domain/game.js';
import type { StoredGamePlatform } from '../../modules/catalog/domain/game-repository.js';
import type { ReviewSummary } from '../../modules/analysis/domain/summary.js';
import type { StoredReview } from '../../modules/reviews/domain/review.js';
import type { Run } from '../../modules/monitoring/domain/run.js';
import type {
  RunClaimCounters,
  RunStageCounters,
} from '../../modules/ingestion/domain/claim-repository.js';
import type { SimilarGame } from '../../modules/similarity/domain/similarity.js';
import type { VideoInsight } from '../../modules/video/domain/video.js';

// ============================================================================
// Пагинация
// ============================================================================

export interface PaginationDto {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface PagedDto<T> {
  readonly items: readonly T[];
  readonly pagination: PaginationDto;
}

export function toPagination(params: {
  page: number;
  pageSize: number;
  total: number;
}): PaginationDto {
  return {
    page: params.page,
    pageSize: params.pageSize,
    total: params.total,
    // Ноль записей — одна пустая страница, а не ноль страниц: иначе
    // page=1 оказался бы вне диапазона на пустом каталоге.
    totalPages: Math.max(1, Math.ceil(params.total / params.pageSize)),
  };
}

// ============================================================================
// Платформы
// ============================================================================

export interface PlatformOptionDto {
  readonly slug: string;
  readonly name: string;
}

/**
 * Платформа в карточке игры.
 *
 * Scope сохраняется намеренно: 'platform' и 'overall' — разные утверждения
 * (ADR-0008). Клиент обязан их различать, иначе общий Userscore будет
 * показан как оценка конкретной платформы.
 */
export interface GamePlatformDto {
  readonly slug: string;
  readonly name: string;
  readonly metascore: number | null;
  readonly metascoreScope: ScoreScope;
  readonly userscore: number | null;
  readonly userscoreScope: ScoreScope;
  readonly criticCount: number | null;
  readonly userCount: number | null;
}

export function toPlatformDto(platform: GamePlatform): GamePlatformDto {
  return {
    slug: platform.platformSlug,
    name: platform.platformName,
    metascore: platform.metascore,
    metascoreScope: platform.metascoreScope,
    userscore: platform.userscore,
    userscoreScope: platform.userscoreScope,
    criticCount: platform.criticCount,
    userCount: platform.userCount,
  };
}

// ============================================================================
// Игры
// ============================================================================

/** Краткая форма для списка: без описания и платформенной разбивки. */
export interface GameListItemDto {
  readonly id: string;
  readonly title: string;
  readonly coverUrl: string | null;
  readonly releaseDate: string | null;
  readonly developer: string | null;
  readonly metascore: number | null;
  readonly userscore: number | null;
}

export function toGameListItemDto(game: Game): GameListItemDto {
  return {
    id: game.id,
    title: game.title,
    coverUrl: game.coverUrl,
    releaseDate: game.releaseDate,
    // Разработчик отдаётся как есть: подмена издателем запрещена (ADR-0003).
    developer: game.developer,
    metascore: game.metascoreOverall,
    userscore: game.userscoreOverall,
  };
}

export interface GameDetailDto {
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

  /** Общие оценки по игре; разбивка — в platforms. */
  readonly metascore: number | null;
  readonly userscore: number | null;

  readonly platforms: readonly GamePlatformDto[];
  /** До пяти похожих игр из каталога; пустой массив, если их нет. */
  readonly similar: readonly SimilarGameDto[];

  readonly sourceUrl: string | null;
  readonly lastUpdatedAt: string;
}

/**
 * Похожая игра.
 *
 * Причины сходства объясняются готовыми формулировками: внутренние веса
 * и названия признаков наружу не отдаются — пользователю нужен ответ
 * «почему похоже», а не устройство алгоритма.
 */
export interface SimilarGameDto {
  readonly id: string;
  readonly title: string;
  readonly coverUrl: string | null;
  readonly releaseDate: string | null;
  readonly metascore: number | null;
  readonly userscore: number | null;
  /** Близость 0..1; для сортировки и возможного показа. */
  readonly score: number;
  /** Человекочитаемые причины, самая весомая первой. */
  readonly reasons: readonly string[];
}

export function toSimilarGameDto(similar: SimilarGame): SimilarGameDto {
  return {
    id: similar.candidate.id,
    title: similar.candidate.title,
    coverUrl: similar.candidate.coverUrl,
    releaseDate: similar.candidate.releaseDate,
    metascore: similar.candidate.metascore,
    userscore: similar.candidate.userscore,
    score: similar.score,
    reasons: similar.reasons.map((reason) => reason.label),
  };
}

export function toGameDetailDto(
  game: Game,
  platforms: readonly StoredGamePlatform[],
  similar: readonly SimilarGame[] = [],
): GameDetailDto {
  return {
    id: game.id,
    title: game.title,
    coverUrl: game.coverUrl,
    description: game.description,
    videoUrl: game.trailerUrl,
    releaseDate: game.releaseDate,
    genres: game.genres,
    developer: game.developer,
    developerStatus: game.developerStatus,
    publishers: game.publishers,
    metascore: game.metascoreOverall,
    userscore: game.userscoreOverall,
    // Наружу идут только активные платформы; отключённые сохранены в БД,
    // но как вариант выбора не предлагаются (ADR-0011).
    platforms: platforms.filter((p) => p.isActive).map(toPlatformDto),
    similar: similar.map(toSimilarGameDto),
    sourceUrl: game.sourceUrl,
    lastUpdatedAt: game.lastUpdatedAt.toISOString(),
  };
}

// ============================================================================
// Анализ отзывов
// ============================================================================

export interface AnalysisPointDto {
  readonly text: string;
  /** Ссылки на отзывы, обосновывающие вывод. Теряться не должны. */
  readonly evidenceRefs: readonly string[];
}

export interface AnalysisThemeDto {
  readonly name: string;
  readonly sentiment: 'positive' | 'negative' | 'neutral' | 'mixed';
  readonly description: string;
  readonly evidenceRefs: readonly string[];
}

/**
 * Резюме одной разновидности отзывов.
 *
 * Поля полноты (analyzedCount, totalAvailable, coverage,
 * snapshotCompleteness) берутся из сохранённых данных и НЕ пересчитываются
 * здесь. Модель на них влиять не может — они вычислены нашим кодом
 * на этапе анализа.
 */
export interface AnalysisDto {
  readonly status: 'ok' | 'insufficient_reviews' | 'failed';
  readonly platformSlug: string;

  readonly summary: string | null;
  readonly liked: readonly AnalysisPointDto[];
  readonly disliked: readonly AnalysisPointDto[];
  readonly themes: readonly AnalysisThemeDto[];
  readonly confidence: 'low' | 'medium' | 'high' | null;

  readonly analyzedCount: number;
  readonly totalAvailable: number | null;
  readonly coverage: 'all_reviews' | 'sample' | null;
  readonly snapshotCompleteness: 'complete' | 'partial' | 'incomplete' | null;

  readonly model: string;
  readonly promptVersion: string;
  readonly analyzedAt: string;
}

export function toAnalysisDto(summary: ReviewSummary): AnalysisDto {
  return {
    status: summary.status,
    platformSlug: summary.platformSlug,
    summary: summary.summary,
    liked: summary.liked.map((point) => ({
      text: point.text,
      evidenceRefs: point.evidenceRefs,
    })),
    disliked: summary.disliked.map((point) => ({
      text: point.text,
      evidenceRefs: point.evidenceRefs,
    })),
    themes: summary.themes.map((theme) => ({
      name: theme.name,
      sentiment: theme.sentiment,
      description: theme.description,
      evidenceRefs: theme.evidenceRefs,
    })),
    confidence: summary.confidence,
    // Значения ниже — из БД, не из ответа модели.
    analyzedCount: summary.analyzedCount,
    totalAvailable: summary.totalAvailable,
    coverage: summary.coverage,
    snapshotCompleteness: summary.snapshotCompleteness,
    model: summary.model,
    promptVersion: summary.promptVersion,
    analyzedAt: summary.generatedAt.toISOString(),
  };
}

/**
 * Анализ по игре: критики и пользователи РАЗДЕЛЕНЫ.
 *
 * Смешивать их нельзя: это разные аудитории и разные шкалы оценок.
 * null означает «анализа нет», а не «мнений нет».
 */
export interface GameAnalysisDto {
  readonly gameId: string;
  readonly critic: AnalysisDto | null;
  readonly user: AnalysisDto | null;
}

// ============================================================================
// Отзывы
// ============================================================================

/**
 * Отзыв в ответе API.
 *
 * Текст отзыва — недоверенное содержимое из внешнего источника. Клиент
 * обязан выводить его как текст, а не как разметку.
 */
export interface ReviewDto {
  readonly id: string;
  readonly kind: 'critic' | 'user';
  readonly platformSlug: string;
  readonly score: number | null;
  readonly quote: string;
  readonly author: string | null;
  readonly reviewUrl: string | null;
  readonly reviewDate: string | null;
}

export function toReviewDto(review: StoredReview): ReviewDto {
  return {
    id: review.id,
    kind: review.identity.kind,
    platformSlug: review.platformSlug,
    score: review.score,
    quote: review.quote,
    author: review.author,
    reviewUrl: review.reviewUrl,
    reviewDate: review.reviewDate,
  };
}

// ============================================================================
// Запуски и мониторинг
// ============================================================================

export interface RunListItemDto {
  readonly id: string;
  readonly trigger: 'cron' | 'manual';
  readonly status: 'running' | 'completed' | 'failed' | 'skipped' | 'blocked';
  readonly processingDay: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly processed: number;
  readonly failed: number;
}

export function toRunListItemDto(run: Run): RunListItemDto {
  return {
    id: run.id,
    trigger: run.trigger,
    status: run.status,
    processingDay: run.processingDay,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    processed: run.processedCount,
    failed: run.failedCount,
  };
}

export interface RunDetailDto extends RunListItemDto {
  readonly source: string | null;
  readonly planned: number;
  readonly claimed: number;
  /** Выполнено полностью — все необязательные стадии тоже прошли. */
  readonly succeeded: number;
  /** Выполнено, но необязательная стадия не удалась (решение OQ-3A-4). */
  readonly partial: number;
  readonly skipped: number;
  readonly pagesScanned: number;
  /** Краткое описание ошибки; трассировка стека наружу не идёт. */
  readonly errorSummary: string | null;
  /** Итоги по стадиям обработки: видно, где именно останавливается работа. */
  readonly stages: readonly RunStageDto[];
}

/** Счётчики одной стадии в рамках запуска. */
export interface RunStageDto {
  readonly stage: string;
  readonly done: number;
  readonly failed: number;
  readonly skipped: number;
  readonly pending: number;
}

export function toRunDetailDto(
  run: Run,
  counters: RunClaimCounters,
  stages: readonly RunStageCounters[] = [],
): RunDetailDto {
  return {
    ...toRunListItemDto(run),
    // Счётчики заявок точнее счётчиков запуска: последние обновляются по
    // ходу работы и после аварийного завершения остаются неполными.
    processed: counters.succeeded + counters.partial,
    failed: counters.failed,
    source: run.sourceStrategy,
    planned: run.plannedCount,
    claimed: run.claimedCount,
    succeeded: counters.succeeded,
    partial: counters.partial,
    // Запланировано, но не взято в работу: батч закончился раньше плана.
    skipped: Math.max(0, run.plannedCount - counters.total),
    pagesScanned: run.pagesScanned,
    errorSummary: run.error,
    stages: stages.map((s) => ({
      stage: s.stage,
      done: s.done,
      failed: s.failed,
      skipped: s.skipped,
      pending: s.pending,
    })),
  };
}

/**
 * Состояние обработчика.
 *
 * Отдельной сущности «worker» в модели нет: обработчики живут в рамках
 * запуска. Состояние выводится из активного запуска, а не хранится
 * (решение по GAP-8) — отдельная таблица ради одного экрана избыточна.
 */
export interface WorkerStatusDto {
  readonly name: string;
  readonly status: 'idle' | 'running';
  readonly lastHeartbeat: string | null;
  readonly currentRunId: string | null;
  readonly processed: number;
  readonly failed: number;
}

export function toWorkerStatusDto(run: Run | null): WorkerStatusDto {
  if (!run) {
    return {
      name: 'daily-processing',
      status: 'idle',
      lastHeartbeat: null,
      currentRunId: null,
      processed: 0,
      failed: 0,
    };
  }

  return {
    name: 'daily-processing',
    status: 'running',
    lastHeartbeat: run.heartbeatAt.toISOString(),
    currentRunId: run.id,
    processed: run.processedCount,
    failed: run.failedCount,
  };
}

/** Итог ручного запуска. */
export interface RunTriggerResultDto {
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
// Обогащение видеообзорами
// ============================================================================

/**
 * Разбор видеообзора.
 *
 * status отражает исход: 'ok' — разбор есть; 'skipped' — ролик или
 * расшифровка недоступны; 'quota_exceeded' — исчерпана квота YouTube;
 * 'failed' — сбой разбора. Отсутствие обогащения не является ошибкой.
 */
export interface VideoInsightDto {
  readonly status: 'ok' | 'failed' | 'skipped' | 'quota_exceeded' | 'none';
  /** Почему разбора нет; null при успехе. */
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

/** Обогащения нет вовсе — игру ещё не обрабатывали. */
export const EMPTY_VIDEO_INSIGHT: VideoInsightDto = {
  status: 'none',
  reason: null,
  videoId: null,
  videoUrl: null,
  videoTitle: null,
  channelTitle: null,
  viewCount: null,
  publishedAt: null,
  durationSeconds: null,
  transcriptSource: 'none',
  summary: null,
  liked: [],
  disliked: [],
  themes: [],
  conclusion: null,
  model: null,
  analyzedAt: null,
};

export function toVideoInsightDto(insight: VideoInsight): VideoInsightDto {
  return {
    status: insight.status,
    reason: insight.lastError,
    videoId: insight.videoId,
    videoUrl: insight.videoUrl,
    videoTitle: insight.videoTitle,
    channelTitle: insight.channelTitle,
    viewCount: insight.viewCount,
    publishedAt: insight.publishedAt,
    durationSeconds: insight.durationSeconds,
    transcriptSource: insight.transcriptSource,
    summary: insight.summary,
    // Наружу идёт текст пунктов; внутренняя структура не нужна клиенту
    liked: insight.liked.map((p) => p.text),
    disliked: insight.disliked.map((p) => p.text),
    themes: insight.themes,
    conclusion: insight.conclusion,
    model: insight.model,
    analyzedAt: insight.generatedAt.toISOString(),
  };
}
