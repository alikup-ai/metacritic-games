import type { StageMap, StageName, StageState } from '../domain/claim.js';
import { isIngestionError } from '../domain/ingestion-errors.js';
import {
  noopEventSink,
  type IngestionEventSink,
} from '../domain/ingestion-events.js';
import type { IngestGameUseCase } from './ingest-game.js';
import type { SyncReviewsUseCase } from '../../reviews/application/sync-reviews.js';
import type { AnalyzeReviewsUseCase } from '../../analysis/application/analyze-reviews.js';
import type { ReviewKind } from '../../reviews/domain/review.js';

/**
 * Обработка ОДНОЙ игры: получение данных, отзывов и разбора.
 *
 * Отдельный компонент, а не часть RunDailyProcessing: тот отвечает за
 * заявки, аренду и пул воркеров, а этот — за последовательность стадий
 * для одной игры. Смешение сделало бы обе задачи непроверяемыми.
 *
 * Стадии независимы: каждая вызывает свой существующий use case и
 * возвращает собственный исход. Внутреннюю логику стадий этот компонент
 * не знает и не дублирует.
 *
 * Разделение критичных и обогащающих стадий взято из домена
 * (isCriticalStage): провал критичной прекращает обработку игры, провал
 * обогащающей оставляет игру пригодной к показу.
 */

export type StageOutcome = 'success' | 'partial' | 'failed' | 'skipped';

export interface StageReport {
  readonly stage: StageName;
  readonly outcome: StageOutcome;
  /** Причина пропуска либо категория ошибки. Без текста отзывов. */
  readonly reason: string | null;
  readonly durationMs: number;
}

export interface ProcessGameResult {
  readonly gameId: string | null;
  /** Итог по игре: успешна ли обязательная часть обработки. */
  readonly outcome: 'success' | 'partial' | 'failed';
  readonly stages: readonly StageReport[];
  /** Карта стадий для сохранения в заявке. */
  readonly stageMap: StageMap;
  readonly errorCategory: string | null;
  readonly errorMessage: string | null;
}

export interface ProcessGamePipelineDeps {
  readonly ingestGame: IngestGameUseCase;
  /** Синхронизация отзывов критиков и пользователей. */
  readonly syncCriticReviews: SyncReviewsUseCase;
  readonly syncUserReviews: SyncReviewsUseCase;
  /**
   * Разбор отзывов. null означает, что анализ выключен конфигурацией —
   * это штатное состояние, а не ошибка.
   */
  readonly analyzeReviews: AnalyzeReviewsUseCase | null;
  readonly events?: IngestionEventSink;
  readonly now: () => Date;
  /**
   * Платформа для анализа. Резюме хранится по (игра, вид, платформа);
   * конвейер разбирает отзывы без разбивки по платформам.
   */
  readonly analysisPlatform: string;
}

export interface ProcessGameParams {
  readonly runId: string;
  readonly sourceSlug: string;
  readonly signal?: AbortSignal;
}

/** Ошибка стадии, приведённая к безопасному для журнала виду. */
function describeError(error: unknown): { category: string; message: string } {
  if (isIngestionError(error)) {
    return { category: error.category, message: error.message };
  }

  // Категория неизвестна — но текст ошибки не расширяем: он может
  // содержать фрагменты ответа источника.
  return {
    category: 'unknown',
    message: error instanceof Error ? error.message : String(error),
  };
}

export class ProcessGamePipeline {
  private readonly events: IngestionEventSink;

  constructor(private readonly deps: ProcessGamePipelineDeps) {
    this.events = deps.events ?? noopEventSink;
  }

  async execute(params: ProcessGameParams): Promise<ProcessGameResult> {
    const stages: StageReport[] = [];
    const stageMap: Record<string, StageState> = {};

    const record = (report: StageReport): void => {
      stages.push(report);

      this.events.emit({
        type: 'stage_finished',
        runId: params.runId,
        sourceSlug: params.sourceSlug,
        stage: report.stage,
        outcome: report.outcome,
        reason: report.reason,
        durationMs: report.durationMs,
      });

      stageMap[report.stage] = {
        status:
          report.outcome === 'success' || report.outcome === 'partial'
            ? 'done'
            : report.outcome,
        at: this.deps.now().toISOString(),
        ...(report.reason !== null
          ? report.outcome === 'failed'
            ? { error: report.reason }
            : { reason: report.reason }
          : {}),
      };
    };

    // --- Стадия 1: данные игры. Критична.
    const ingestStartedAt = this.deps.now().getTime();
    let gameId: string;

    try {
      const ingested = await this.deps.ingestGame.execute({
        sourceSlug: params.sourceSlug,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      gameId = ingested.gameId;

      record({
        stage: 'fetchGame',
        outcome: 'success',
        reason: null,
        durationMs: this.deps.now().getTime() - ingestStartedAt,
      });
    } catch (error) {
      const described = describeError(error);

      record({
        stage: 'fetchGame',
        outcome: 'failed',
        reason: described.category,
        durationMs: this.deps.now().getTime() - ingestStartedAt,
      });

      // Без данных игры остальные стадии бессмысленны: у отзывов и
      // разбора нет идентификатора игры.
      record({
        stage: 'fetchReviews',
        outcome: 'skipped',
        reason: 'ingestion_failed',
        durationMs: 0,
      });
      record({
        stage: 'summarize',
        outcome: 'skipped',
        reason: 'ingestion_failed',
        durationMs: 0,
      });

      return {
        gameId: null,
        outcome: 'failed',
        stages,
        stageMap,
        errorCategory: described.category,
        errorMessage: described.message,
      };
    }

    // --- Стадия 2: отзывы. Критична.
    const reviewsStartedAt = this.deps.now().getTime();
    const reviewsResult = await this.syncReviews(params, gameId);

    record({
      stage: 'fetchReviews',
      outcome: reviewsResult.outcome,
      reason: reviewsResult.reason,
      durationMs: this.deps.now().getTime() - reviewsStartedAt,
    });

    if (reviewsResult.outcome === 'failed') {
      // Разбор по пустому либо недостоверному набору отзывов дал бы
      // ложные выводы, поэтому он не запускается.
      record({
        stage: 'summarize',
        outcome: 'skipped',
        reason: 'reviews_failed',
        durationMs: 0,
      });

      return {
        gameId,
        outcome: 'failed',
        stages,
        stageMap,
        errorCategory: reviewsResult.reason,
        errorMessage: reviewsResult.message,
      };
    }

    // --- Стадия 3: разбор отзывов. Обогащающая.
    const analysisStartedAt = this.deps.now().getTime();
    const analysisResult = await this.analyze(params, gameId);

    record({
      stage: 'summarize',
      outcome: analysisResult.outcome,
      reason: analysisResult.reason,
      durationMs: this.deps.now().getTime() - analysisStartedAt,
    });

    // Провал обогащающей стадии не делает игру необработанной: данные и
    // отзывы сохранены и пригодны к показу.
    //
    // 'success' означает, что полностью удались ВСЕ стадии. Неполный
    // снимок отзывов тоже понижает исход: разбор по нему верен лишь
    // отчасти, и выдавать это за полный успех нельзя.
    const everythingComplete =
      reviewsResult.outcome === 'success' && analysisResult.outcome === 'success';

    const outcome = everythingComplete ? 'success' : ('partial' as const);

    return {
      gameId,
      outcome,
      stages,
      stageMap,
      errorCategory: null,
      errorMessage: null,
    };
  }

  /**
   * Синхронизация отзывов обоих видов.
   *
   * Виды независимы: сбой одного не отменяет другой. Неполный снимок —
   * это `partial`, а не отказ: часть отзывов лучше, чем ничего, и
   * полнота честно сохраняется в снимке.
   */
  private async syncReviews(
    params: ProcessGameParams,
    gameId: string,
  ): Promise<{ outcome: StageOutcome; reason: string | null; message: string | null }> {
    const kinds: readonly { kind: ReviewKind; useCase: SyncReviewsUseCase }[] = [
      { kind: 'critic', useCase: this.deps.syncCriticReviews },
      { kind: 'user', useCase: this.deps.syncUserReviews },
    ];

    let anySucceeded = false;
    let anyPartial = false;
    let lastError: { category: string; message: string } | null = null;

    for (const { kind, useCase } of kinds) {
      try {
        const result = await useCase.execute({
          gameId,
          sourceSlug: params.sourceSlug,
          kind,
          ...(params.signal ? { signal: params.signal } : {}),
        });

        // Синхронизация не бросает исключение при недоступном источнике:
        // она деградирует, возвращая пустой неполный снимок (Phase 1D).
        // Для конвейера «ничего не получено и снимок неполон» — это
        // отказ, а не частичный успех: разбирать нечего.
        const emptyAndIncomplete =
          result.fetched === 0 && result.completeness === 'incomplete';

        if (emptyAndIncomplete) {
          lastError = {
            category: 'reviews_unavailable',
            message: 'Отзывы не получены: источник недоступен',
          };
          continue;
        }

        anySucceeded = true;
        if (result.completeness !== 'complete') anyPartial = true;
      } catch (error) {
        lastError = describeError(error);
      }
    }

    if (!anySucceeded) {
      return {
        outcome: 'failed',
        reason: lastError?.category ?? 'reviews_failed',
        message: lastError?.message ?? 'Не удалось получить отзывы',
      };
    }

    // Один вид получен, другой — нет: данные есть, но не полны.
    if (lastError !== null || anyPartial) {
      return { outcome: 'partial', reason: 'incomplete_reviews', message: null };
    }

    return { outcome: 'success', reason: null, message: null };
  }

  /**
   * Разбор отзывов.
   *
   * Выключенный анализ и сбой провайдера различимы: первое — `skipped`
   * с причиной `llm_disabled`, второе — `failed`. Смешивать их нельзя:
   * первое штатно, второе требует внимания.
   */
  private async analyze(
    params: ProcessGameParams,
    gameId: string,
  ): Promise<{ outcome: StageOutcome; reason: string | null }> {
    const analyzer = this.deps.analyzeReviews;

    if (!analyzer) {
      return { outcome: 'skipped', reason: 'llm_disabled' };
    }

    const kinds: readonly ReviewKind[] = ['critic', 'user'];
    let anySucceeded = false;
    let anySkipped = false;
    let lastFailure: string | null = null;

    for (const kind of kinds) {
      try {
        const result = await analyzer.execute({
          gameId,
          // Заголовок нужен модели для контекста; берётся из slug, так как
          // конвейер не обращается к каталогу повторно.
          gameTitle: params.sourceSlug,
          kind,
          platformSlug: this.deps.analysisPlatform,
          ...(params.signal ? { signal: params.signal } : {}),
        });

        // 'skipped' означает совпадение входного хеша: модель не
        // вызывалась, потому что результат уже есть (Phase 2B).
        if (result.status === 'ok' || result.status === 'skipped') {
          anySucceeded = true;
        } else if (result.status === 'insufficient_reviews') {
          anySkipped = true;
        } else {
          lastFailure = 'analysis_failed';
        }
      } catch (error) {
        lastFailure = describeError(error).category;
      }
    }

    if (anySucceeded) {
      return lastFailure !== null
        ? { outcome: 'partial', reason: lastFailure }
        : { outcome: 'success', reason: null };
    }

    if (lastFailure !== null) {
      return { outcome: 'failed', reason: lastFailure };
    }

    // Ни одного анализа не выполнено, но и ошибок не было: отзывов мало.
    return {
      outcome: 'skipped',
      reason: anySkipped ? 'insufficient_reviews' : 'no_reviews',
    };
  }
}
