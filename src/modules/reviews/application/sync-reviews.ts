import type { UnitOfWork } from '../../catalog/domain/unit-of-work.js';
import { isIngestionError } from '../../ingestion/domain/ingestion-errors.js';
import {
  canDeleteMissing,
  reviewKey,
  type ReviewKind,
  type SnapshotCompleteness,
} from '../domain/review.js';
import {
  noopReviewEventSink,
  type ReviewEventSink,
} from '../domain/review-events.js';
import type {
  ReviewRepository,
  ReviewSnapshotRepository,
} from '../domain/review-ports.js';
import { fetchAllReviews, type FetchReviewsDeps } from './fetch-reviews.js';

/**
 * Синхронизация отзывов одного типа для одной игры.
 *
 * Порядок операций (ADR-0012):
 *   1) многостраничный обход источника — ВНЕ транзакции;
 *   2) сравнение отпечатка со снимком: совпал — работа окончена;
 *   3) транзакция: отзывы + удаление исчезнувших + метаданные снимка.
 *
 * Отзывы и снимок фиксируются вместе: иначе возможно состояние «отзывы
 * обновлены, отпечаток старый», при котором следующий обход счёл бы набор
 * неизменным и не пересчитал резюме.
 */

export interface SyncReviewsDeps extends FetchReviewsDeps {
  readonly reviews: ReviewRepository;
  readonly snapshots: ReviewSnapshotRepository;
  readonly unitOfWork: UnitOfWork;
  readonly events?: ReviewEventSink;
  /** Хеширование передаётся снаружи: домен не зависит от crypto платформы. */
  readonly hash: (input: string) => string;
  readonly now?: () => Date;
}

export interface SyncReviewsParams {
  readonly gameId: string;
  readonly sourceSlug: string;
  readonly kind: ReviewKind;
  readonly platform?: string;
  readonly signal?: AbortSignal;
}

export interface SyncReviewsResult {
  readonly kind: ReviewKind;
  readonly platformSlug: string;
  readonly fetched: number;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly deleted: number;
  readonly completeness: SnapshotCompleteness;
  /** true, если отпечаток совпал и запись в БД не выполнялась. */
  readonly skipped: boolean;
}

export class SyncReviewsUseCase {
  private readonly events: ReviewEventSink;
  private readonly now: () => Date;

  constructor(private readonly deps: SyncReviewsDeps) {
    this.events = deps.events ?? noopReviewEventSink;
    this.now = deps.now ?? (() => new Date());
  }

  async execute(params: SyncReviewsParams): Promise<SyncReviewsResult> {
    const platformSlug = params.platform ?? 'default';
    const startedAt = Date.now();

    this.events.emit({
      type: 'review_fetch_started',
      sourceSlug: params.sourceSlug,
      kind: params.kind,
      platformSlug,
    });

    // --- Шаг 1: сеть, вне транзакции
    let fetched;
    try {
      fetched = await fetchAllReviews(this.deps, {
        sourceSlug: params.sourceSlug,
        kind: params.kind,
        ...(params.platform ? { platform: params.platform } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      });
    } catch (error) {
      this.events.emit({
        type: 'review_fetch_failed',
        sourceSlug: params.sourceSlug,
        kind: params.kind,
        platformSlug,
        errorCategory: isIngestionError(error) ? error.category : 'unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }

    this.events.emit({
      type: 'review_fetch_completed',
      sourceSlug: params.sourceSlug,
      kind: params.kind,
      platformSlug,
      fetched: fetched.reviews.length,
      totalAvailable: fetched.totalAvailable,
      pagesScanned: fetched.pagesScanned,
      completeness: fetched.completeness,
      stopReason: fetched.stopReason,
      durationMs: Date.now() - startedAt,
    });

    if (fetched.malformed > 0) {
      this.events.emit({
        type: 'review_parse_failed',
        sourceSlug: params.sourceSlug,
        kind: params.kind,
        platformSlug,
        malformed: fetched.malformed,
        parsed: fetched.reviews.length,
      });
    }

    // --- Шаг 2: сравнение отпечатка
    const fingerprint = this.deps.hash(
      fetched.reviews
        .map((review) => `${reviewKey(review.identity)}:${review.score ?? ''}`)
        .sort()
        .join('\n'),
    );

    const existing = await this.deps.snapshots.find({
      gameId: params.gameId,
      kind: params.kind,
      platformSlug,
    });

    // Отпечаток совпал — набор не изменился. Но пропускать можно только
    // если ПРЕДЫДУЩИЙ снимок был полным: неполный требует повторной
    // попытки, иначе деградация закрепилась бы навсегда.
    if (
      existing &&
      existing.fingerprint === fingerprint &&
      existing.completeness === 'complete'
    ) {
      this.events.emit({
        type: 'review_snapshot_skipped',
        sourceSlug: params.sourceSlug,
        kind: params.kind,
        platformSlug,
        gameId: params.gameId,
        reason: 'fingerprint_unchanged',
        reviewCount: existing.reviewCount,
      });

      return {
        kind: params.kind,
        platformSlug,
        fetched: fetched.reviews.length,
        created: 0,
        updated: 0,
        unchanged: existing.reviewCount,
        deleted: 0,
        completeness: existing.completeness,
        skipped: true,
      };
    }

    // --- Шаг 3: транзакция
    const result = await this.deps.unitOfWork.withTransaction(async (tx) => {
      const upserted = await this.deps.reviews.upsertMany({
        gameId: params.gameId,
        kind: params.kind,
        platformSlug,
        reviews: fetched.reviews,
        tx,
      });

      // Удаление исчезнувших — ТОЛЬКО при полном снимке. При частичном
      // отсутствие отзыва означает, что он не попал в выборку.
      let deleted = 0;
      if (canDeleteMissing(fetched.completeness)) {
        deleted = await this.deps.reviews.deleteMissing({
          gameId: params.gameId,
          kind: params.kind,
          platformSlug,
          presentKeys: fetched.reviews.map((review) => reviewKey(review.identity)),
          tx,
        });
      }

      await this.deps.snapshots.save(
        {
          gameId: params.gameId,
          kind: params.kind,
          platformSlug,
          fingerprint,
          reviewCount: fetched.reviews.length,
          totalAvailable: fetched.totalAvailable,
          completeness: fetched.completeness,
          malformedCount: fetched.malformed,
          fetchedAt: this.now(),
        },
        tx,
      );

      return { ...upserted, deleted };
    });

    this.events.emit({
      type: 'review_snapshot_created',
      sourceSlug: params.sourceSlug,
      kind: params.kind,
      platformSlug,
      gameId: params.gameId,
      created: result.created,
      updated: result.updated,
      unchanged: result.unchanged,
      deleted: result.deleted,
      completeness: fetched.completeness,
    });

    return {
      kind: params.kind,
      platformSlug,
      fetched: fetched.reviews.length,
      created: result.created,
      updated: result.updated,
      unchanged: result.unchanged,
      deleted: result.deleted,
      completeness: fetched.completeness,
      skipped: false,
    };
  }
}
