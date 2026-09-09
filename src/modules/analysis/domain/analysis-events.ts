/**
 * События анализа отзывов.
 *
 * В события НЕ попадают: ключи API, промпт, тексты отзывов, полный ответ
 * модели. Только контекст и счётчики.
 */

import type { ReviewKind } from '../../reviews/domain/review.js';
import type { AnalysisConfidence } from './llm-provider.js';

export type AnalysisEventType =
  | 'llm_analysis_started'
  | 'llm_analysis_completed'
  | 'llm_analysis_skipped'
  | 'llm_analysis_failed';

interface BaseAnalysisEvent {
  readonly gameId: string;
  readonly kind: ReviewKind;
  readonly platformSlug: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly samplingVersion: string;
}

export interface AnalysisStartedEvent extends BaseAnalysisEvent {
  readonly type: 'llm_analysis_started';
  readonly inputCount: number;
  readonly coverage: string;
}

export interface AnalysisCompletedEvent extends BaseAnalysisEvent {
  readonly type: 'llm_analysis_completed';
  readonly inputCount: number;
  readonly coverage: string;
  readonly confidence: AnalysisConfidence;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly durationMs: number;
  readonly attempts: number;
}

export interface AnalysisSkippedEvent extends BaseAnalysisEvent {
  readonly type: 'llm_analysis_skipped';
  readonly reason: 'input_unchanged' | 'insufficient_reviews' | 'disabled';
  readonly reviewCount: number;
}

export interface AnalysisFailedEvent extends BaseAnalysisEvent {
  readonly type: 'llm_analysis_failed';
  readonly errorCategory: string;
  readonly errorMessage: string;
  readonly durationMs: number;
  readonly attempts: number;
}

export type AnalysisEvent =
  | AnalysisStartedEvent
  | AnalysisCompletedEvent
  | AnalysisSkippedEvent
  | AnalysisFailedEvent;

export interface AnalysisEventSink {
  emit(event: AnalysisEvent): void;
}

export const noopAnalysisEventSink: AnalysisEventSink = {
  emit: () => undefined,
};

/** Собирает события в память — для тестов. */
export class RecordingAnalysisEventSink implements AnalysisEventSink {
  readonly events: AnalysisEvent[] = [];

  emit(event: AnalysisEvent): void {
    this.events.push(event);
  }

  ofType<T extends AnalysisEventType>(type: T): Extract<AnalysisEvent, { type: T }>[] {
    return this.events.filter(
      (event): event is Extract<AnalysisEvent, { type: T }> => event.type === type,
    );
  }
}
