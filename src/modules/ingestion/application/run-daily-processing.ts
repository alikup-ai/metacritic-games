import type { ClaimRepository } from '../domain/claim-repository.js';
import type { DailyClaim } from '../domain/claim.js';
import { isIngestionError } from '../domain/ingestion-errors.js';
import {
  noopEventSink,
  type IngestionEventSink,
} from '../domain/ingestion-events.js';
import type { ProcessingDayProvider } from '../domain/processing-day-provider.js';
import type { RunLock, RunRepository, RunTrigger } from '../../monitoring/domain/run.js';
import type { FindNextClaimableGamesUseCase } from './find-next-claimable-games.js';
import type { ProcessGamePipeline } from './process-game-pipeline.js';
import { runWorkerPool, withHeartbeat } from './worker-pool.js';

/**
 * Запуск суточной обработки: поиск кандидатов, захват заявок и обработка
 * пулом воркеров.
 *
 * Разделение ответственности (требование §7 задания):
 *   блокировка   — защита от лишней параллельной работы;
 *   реестр заявок — источник истины для идемпотентности.
 *
 * Даже при потерянной блокировке двойная обработка невозможна: заявку на
 * игру в конкретные сутки может создать только один процесс.
 */

export interface RunDailyProcessingDeps {
  readonly findCandidates: FindNextClaimableGamesUseCase;
  /**
   * Обработка одной игры: данные, отзывы, разбор.
   *
   * Последовательность стадий вынесена отдельно: здесь остаётся работа
   * с заявками, арендой и пулом воркеров.
   */
  readonly pipeline: ProcessGamePipeline;
  readonly claims: ClaimRepository;
  readonly runs: RunRepository;
  readonly runLock: RunLock;
  readonly dayProvider: ProcessingDayProvider;
  readonly events?: IngestionEventSink;
  readonly batchSize: number;
  readonly workerConcurrency: number;
  readonly leaseMinutes: number;
  readonly heartbeatIntervalMs: number;
  readonly maxAttempts: number;
  /** Таймеры передаются снаружи — application не зависит от Node API. */
  readonly timers?: {
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
}

export interface RunDailyProcessingParams {
  readonly trigger: RunTrigger;
  readonly signal?: AbortSignal;
}

export type RunOutcome = 'completed' | 'failed' | 'skipped';

/**
 * Сбой обработки игры, уже отражённый в заявке и событиях.
 *
 * Пробрасывается только для того, чтобы пул воркеров учёл задачу как
 * неуспешную; повторно фиксировать его не нужно.
 */
class AlreadyReportedFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlreadyReportedFailure';
  }
}

export interface RunDailyProcessingResult {
  readonly outcome: RunOutcome;
  readonly runId: string | null;
  readonly processingDay: string;
  readonly claimed: number;
  readonly processed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly stopReason: string | null;
}

export class RunDailyProcessingUseCase {
  private readonly events: IngestionEventSink;

  constructor(private readonly deps: RunDailyProcessingDeps) {
    this.events = deps.events ?? noopEventSink;
  }

  async execute(params: RunDailyProcessingParams): Promise<RunDailyProcessingResult> {
    const processingDay = this.deps.dayProvider.currentProcessingDay();
    const startedAt = this.deps.dayProvider.now().getTime();

    // Блокировка берётся ДО создания запуска: иначе в таблице копились бы
    // записи о запусках, которые ничего не делали.
    const lock = await this.deps.runLock.tryAcquire();
    if (!lock) {
      this.events.emit({
        type: 'run_skipped',
        reason: 'already_running',
        processingDay,
      });
      return {
        outcome: 'skipped',
        runId: null,
        processingDay,
        claimed: 0,
        processed: 0,
        failed: 0,
        skipped: 0,
        stopReason: null,
      };
    }

    let runId: string | null = null;

    try {
      // Заявки, брошенные упавшими воркерами, возвращаются в пул до начала
      // поиска — иначе они не попали бы в сегодняшнюю обработку.
      const reaped = await this.deps.claims.reapExpiredLeases({
        now: this.deps.dayProvider.now(),
        maxAttempts: this.deps.maxAttempts,
      });
      if (reaped.revived > 0 || reaped.failed > 0) {
        this.events.emit({
          type: 'claim_recovered',
          processingDay,
          revived: reaped.revived,
          failed: reaped.failed,
        });
      }

      const run = await this.deps.runs.start(params.trigger, {
        lockKey: this.deps.runLock.lockKey,
        processingDay,
      });
      runId = run.id;

      this.events.emit({
        type: 'run_started',
        runId: run.id,
        processingDay,
        trigger: params.trigger,
      });

      const found = await this.deps.findCandidates.execute({
        processingDay,
        runId: run.id,
        targetCount: this.deps.batchSize,
        ...(params.signal ? { signal: params.signal } : {}),
      });

      await this.deps.runs.updateDailyContext(run.id, {
        sourceStrategy: found.strategy,
        lastPageHint: found.lastPage,
        pagesScanned: found.pagesScanned,
      });

      if (found.skippedAlreadyClaimed > 0) {
        this.events.emit({
          type: 'claim_skipped',
          runId: run.id,
          processingDay,
          count: found.skippedAlreadyClaimed,
          reason: 'already_claimed_today',
        });
      }

      for (const claim of found.claims) {
        this.events.emit({
          type: 'claim_created',
          runId: run.id,
          processingDay,
          sourceSlug: claim.sourceSlug,
          attempts: claim.attempts,
        });
      }

      await this.deps.runs.incrementCounters(run.id, {
        plannedCount: found.claims.length,
        claimedCount: found.claims.length,
      });

      const poolResult = await this.processClaims(run.id, found.claims, params.signal);

      await this.deps.runs.finish({
        runId: run.id,
        status: 'completed',
        counters: {
          processedCount: poolResult.succeeded,
          failedCount: poolResult.failed,
        },
      });

      const durationMs = this.deps.dayProvider.now().getTime() - startedAt;
      this.events.emit({
        type: 'run_completed',
        runId: run.id,
        processingDay,
        claimed: found.claims.length,
        processed: poolResult.succeeded,
        failed: poolResult.failed,
        skipped: poolResult.skipped,
        pagesScanned: found.pagesScanned,
        strategy: found.strategy,
        stopReason: found.stopReason,
        durationMs,
      });

      return {
        outcome: 'completed',
        runId: run.id,
        processingDay,
        claimed: found.claims.length,
        processed: poolResult.succeeded,
        failed: poolResult.failed,
        skipped: poolResult.skipped,
        stopReason: found.stopReason,
      };
    } catch (error) {
      const durationMs = this.deps.dayProvider.now().getTime() - startedAt;
      const category = isIngestionError(error) ? error.category : 'unknown';
      const message = error instanceof Error ? error.message : String(error);

      if (runId) {
        // Блокировка источника требует иной реакции, чем обычная ошибка,
        // поэтому статус различается.
        await this.deps.runs
          .finish({
            runId,
            status: category === 'blocked' ? 'blocked' : 'failed',
            error: message.slice(0, 2000),
          })
          .catch(() => undefined);

        this.events.emit({
          type: 'run_failed',
          runId,
          processingDay,
          errorCategory: category,
          errorMessage: message,
          durationMs,
        });
      }

      return {
        outcome: 'failed',
        runId,
        processingDay,
        claimed: 0,
        processed: 0,
        failed: 0,
        skipped: 0,
        stopReason: null,
      };
    } finally {
      await lock.release();
    }
  }

  /** Обрабатывает заявки пулом воркеров с ограниченным параллелизмом. */
  private async processClaims(
    runId: string,
    claims: readonly DailyClaim[],
    signal: AbortSignal | undefined,
  ): Promise<{ succeeded: number; failed: number; skipped: number }> {
    const result = await runWorkerPool(
      claims,
      async (claim) => this.processOneClaim(runId, claim, signal),
      {
        concurrency: this.deps.workerConcurrency,
        ...(signal ? { signal } : {}),
      },
    );

    return {
      succeeded: result.succeeded,
      failed: result.failed,
      skipped: result.skipped,
    };
  }

  /**
   * Обработка одной заявки.
   *
   * Ошибка фиксируется на самой заявке и не пробрасывается наружу: сбой
   * одной игры не должен останавливать остальные.
   */
  private async processOneClaim(
    runId: string,
    claim: DailyClaim,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const startedAt = this.deps.dayProvider.now().getTime();
    // Признак того, что заявка перестала принадлежать этому запуску:
    // выставляется неудачным продлением аренды.
    let lostOwnership = false;

    this.events.emit({
      type: 'game_processing_started',
      runId,
      sourceSlug: claim.sourceSlug,
      attempts: claim.attempts,
    });

    const timers = this.deps.timers ?? {
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
      clearInterval: (handle: unknown) => clearInterval(handle as NodeJS.Timeout),
    };

    try {
      const result = await withHeartbeat(
        async () =>
          // Конвейер сам решает, какие стадии выполнять и как отразить
          // их исход: здесь эта логика не дублируется.
          this.deps.pipeline.execute({
            runId,
            sourceSlug: claim.sourceSlug,
            ...(signal ? { signal } : {}),
          }),
        // Продление аренды не даёт reaper'у забрать живую работу.
        // Возврат false означает, что заявка уже отобрана: продолжать
        // обработку нельзя, иначе игра обрабатывалась бы дважды.
        async () => {
          const held = await this.deps.claims.extendLease({
            day: claim.processingDay,
            source: claim.source,
            sourceSlug: claim.sourceSlug,
            leaseMinutes: this.deps.leaseMinutes,
            runId,
          });

          if (!held) {
            lostOwnership = true;
          }
        },
        {
          intervalMs: this.deps.heartbeatIntervalMs,
          setInterval: timers.setInterval,
          clearInterval: timers.clearInterval,
        },
      );

      // Заявка могла быть отобрана reaper'ом, пока шла обработка. Тогда
      // её уже перезахватил другой запуск, и завершать её от своего имени
      // нельзя: это затёрло бы чужой прогресс.
      if (lostOwnership) {
        this.events.emit({
          type: 'game_processing_failed',
          runId,
          sourceSlug: claim.sourceSlug,
          errorCategory: 'lease_lost',
          errorMessage:
            'Аренда заявки истекла и была отобрана: результат не сохраняется как завершение',
          attempts: claim.attempts,
        });
        return;
      }

      // Провал критичной стадии — это неуспех игры, даже если сам
      // конвейер завершился без исключения: заявка не должна выглядеть
      // обработанной.
      if (result.outcome === 'failed') {
        await this.deps.claims
          .markFailed({
            day: claim.processingDay,
            source: claim.source,
            sourceSlug: claim.sourceSlug,
            error: result.errorMessage ?? 'Обработка не выполнена',
            stages: result.stageMap,
          })
          .catch(() => undefined);

        this.events.emit({
          type: 'game_processing_failed',
          runId,
          sourceSlug: claim.sourceSlug,
          errorCategory: result.errorCategory ?? 'unknown',
          errorMessage: result.errorMessage ?? 'Обработка не выполнена',
          attempts: claim.attempts,
        });

        // Пул считает задачу неуспешной; остальные игры продолжаются.
        // Пометка не даёт внешнему обработчику записать сбой повторно.
        throw new AlreadyReportedFailure(
          result.errorMessage ?? 'Обработка не выполнена',
        );
      }

      await this.deps.claims.markDone({
        day: claim.processingDay,
        source: claim.source,
        sourceSlug: claim.sourceSlug,
        gameId: result.gameId!,
        // Карта стадий отражает то, что действительно выполнялось.
        stages: result.stageMap,
      });

      this.events.emit({
        type: 'game_processing_completed',
        runId,
        sourceSlug: claim.sourceSlug,
        gameId: result.gameId!,
        durationMs: this.deps.dayProvider.now().getTime() - startedAt,
      });
    } catch (error) {
      // Сбой конвейера уже записан и опубликован выше: повторная запись
      // затёрла бы карту стадий, а второе событие исказило бы счётчики.
      if (error instanceof AlreadyReportedFailure) throw error;

      const category = isIngestionError(error) ? error.category : 'unknown';
      const message = error instanceof Error ? error.message : String(error);

      await this.deps.claims
        .markFailed({
          day: claim.processingDay,
          source: claim.source,
          sourceSlug: claim.sourceSlug,
          error: message,
          stages: { fetchGame: { status: 'failed', error: category } },
        })
        .catch(() => undefined);

      this.events.emit({
        type: 'game_processing_failed',
        runId,
        sourceSlug: claim.sourceSlug,
        errorCategory: category,
        errorMessage: message,
        attempts: claim.attempts,
      });

      // Ошибка пробрасывается в пул, чтобы попасть в счётчик неудач;
      // пул изолирует её и продолжает остальные задачи.
      throw error;
    }
  }
}
