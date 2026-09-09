/**
 * Доменная модель резюме отзывов.
 */

import type { TxContext } from '../../catalog/domain/unit-of-work.js';
import type { ReviewKind, SnapshotCompleteness } from '../../reviews/domain/review.js';
import type {
  AnalysisConfidence,
  AnalysisPoint,
  AnalysisTheme,
} from './llm-provider.js';

/**
 * Статус резюме.
 * `insufficient_reviews` отличает «отзывов почти нет» от «анализ не удался»:
 * реакция на них разная, и первое не является ошибкой.
 */
export type SummaryStatus = 'ok' | 'insufficient_reviews' | 'failed';

export type ReviewCoverage = 'all_reviews' | 'sample';

export interface ReviewSummary {
  readonly gameId: string;
  readonly kind: ReviewKind;
  readonly platformSlug: string;
  readonly status: SummaryStatus;

  readonly summary: string | null;
  readonly liked: readonly AnalysisPoint[];
  readonly disliked: readonly AnalysisPoint[];
  readonly themes: readonly AnalysisTheme[];
  readonly confidence: AnalysisConfidence | null;

  /** Ключ идемпотентности; заполнен при успешном анализе. */
  readonly inputHash: string | null;
  readonly sourceFingerprint: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly samplingVersion: string | null;

  /** Вычисляется НАШИМ кодом, не моделью. */
  readonly analyzedCount: number;
  readonly totalAvailable: number | null;
  readonly snapshotCompleteness: SnapshotCompleteness | null;
  readonly coverage: ReviewCoverage | null;

  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly lastError: string | null;
  readonly errorCategory: string | null;
  readonly generatedAt: Date;
}

export interface ReviewSummaryRepository {
  find(params: {
    gameId: string;
    kind: ReviewKind;
    platformSlug: string;
    tx?: TxContext;
  }): Promise<ReviewSummary | null>;

  /**
   * Сохраняет резюме, заменяя предыдущее для той же тройки.
   *
   * Записываются только поля резюме: вывод модели не должен затрагивать
   * игры, отзывы или что-либо ещё.
   */
  /**
   * Все резюме игры: обе разновидности по всем платформам.
   *
   * Нужен интерфейсу, который показывает анализ критиков и пользователей
   * рядом. Перебор платформ на стороне вызывающего дал бы N запросов.
   */
  findByGame(gameId: string, tx?: TxContext): Promise<readonly ReviewSummary[]>;

  save(summary: ReviewSummary, tx?: TxContext): Promise<void>;
}
