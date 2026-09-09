/**
 * События обработки отзывов.
 *
 * Порт в domain: способ доставки (лог, БД, SSE) подменяется без изменения
 * бизнес-логики. Тексты отзывов в события не попадают — только счётчики.
 */

import type { ReviewKind, SnapshotCompleteness } from './review.js';

export type ReviewEventType =
  | 'review_fetch_started'
  | 'review_fetch_completed'
  | 'review_fetch_failed'
  | 'review_snapshot_created'
  | 'review_snapshot_skipped'
  | 'review_parse_failed';

interface BaseReviewEvent {
  readonly sourceSlug: string;
  readonly kind: ReviewKind;
  readonly platformSlug: string;
}

export interface ReviewFetchStartedEvent extends BaseReviewEvent {
  readonly type: 'review_fetch_started';
}

export interface ReviewFetchCompletedEvent extends BaseReviewEvent {
  readonly type: 'review_fetch_completed';
  readonly fetched: number;
  readonly totalAvailable: number;
  readonly pagesScanned: number;
  readonly completeness: SnapshotCompleteness;
  readonly stopReason: string;
  readonly durationMs: number;
}

export interface ReviewFetchFailedEvent extends BaseReviewEvent {
  readonly type: 'review_fetch_failed';
  readonly errorCategory: string;
  readonly errorMessage: string;
  readonly durationMs: number;
}

export interface ReviewSnapshotCreatedEvent extends BaseReviewEvent {
  readonly type: 'review_snapshot_created';
  readonly gameId: string;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly deleted: number;
  readonly completeness: SnapshotCompleteness;
}

/** Снимок не изменился: отпечаток совпал, пересчёт не нужен. */
export interface ReviewSnapshotSkippedEvent extends BaseReviewEvent {
  readonly type: 'review_snapshot_skipped';
  readonly gameId: string;
  readonly reason: 'fingerprint_unchanged';
  readonly reviewCount: number;
}

export interface ReviewParseFailedEvent extends BaseReviewEvent {
  readonly type: 'review_parse_failed';
  readonly malformed: number;
  readonly parsed: number;
}

export type ReviewEvent =
  | ReviewFetchStartedEvent
  | ReviewFetchCompletedEvent
  | ReviewFetchFailedEvent
  | ReviewSnapshotCreatedEvent
  | ReviewSnapshotSkippedEvent
  | ReviewParseFailedEvent;

export interface ReviewEventSink {
  emit(event: ReviewEvent): void;
}

export const noopReviewEventSink: ReviewEventSink = {
  emit: () => undefined,
};

/** Собирает события в память — для тестов. */
export class RecordingReviewEventSink implements ReviewEventSink {
  readonly events: ReviewEvent[] = [];

  emit(event: ReviewEvent): void {
    this.events.push(event);
  }

  ofType<T extends ReviewEventType>(type: T): Extract<ReviewEvent, { type: T }>[] {
    return this.events.filter(
      (event): event is Extract<ReviewEvent, { type: T }> => event.type === type,
    );
  }
}
