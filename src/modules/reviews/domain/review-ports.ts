/**
 * Порты модуля отзывов.
 *
 * Объявлены в domain, реализуются в infrastructure (ADR-0001).
 * Три порта, без лишних абстракций: источник, хранилище отзывов, хранилище
 * метаданных снимка.
 */

import type { TxContext } from '../../catalog/domain/unit-of-work.js';
import type {
  NormalizedReview,
  NormalizedReviewPage,
  ReviewKind,
  ReviewSnapshot,
  StoredReview,
} from './review.js';

export interface FetchReviewPageParams {
  readonly sourceSlug: string;
  readonly kind: ReviewKind;
  /** Платформа; при отсутствии источник отдаёт основную платформу игры. */
  readonly platform?: string;
  readonly offset: number;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

/** Источник отзывов. Реализация скрывает HTTP и формат ответа. */
export interface ReviewSource {
  fetchReviewPage(params: FetchReviewPageParams): Promise<NormalizedReviewPage>;
}

/** Итог синхронизации набора отзывов. */
export interface ReviewSyncResult {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly deleted: number;
}

export interface ReviewRepository {
  /**
   * Создаёт или обновляет отзывы по ключу источника.
   *
   * Идемпотентен: повторная обработка того же набора не создаёт дубликатов.
   * Различает создание, обновление (изменился content_hash) и отсутствие
   * изменений.
   */
  upsertMany(params: {
    gameId: string;
    kind: ReviewKind;
    platformSlug: string;
    reviews: readonly NormalizedReview[];
    tx?: TxContext;
  }): Promise<Omit<ReviewSyncResult, 'deleted'>>;

  /**
   * Удаляет отзывы, отсутствующие в переданном наборе ключей.
   *
   * Вызывается ТОЛЬКО при полном снимке: при частичном отсутствие отзыва
   * не означает удаления.
   */
  deleteMissing(params: {
    gameId: string;
    kind: ReviewKind;
    platformSlug: string;
    presentKeys: readonly string[];
    tx?: TxContext;
  }): Promise<number>;

  findByGame(params: {
    gameId: string;
    kind: ReviewKind;
    platformSlug: string;
    tx?: TxContext;
  }): Promise<readonly StoredReview[]>;

  countByGame(params: {
    gameId: string;
    kind: ReviewKind;
    platformSlug: string;
    tx?: TxContext;
  }): Promise<number>;

  /**
   * Страница отзывов с общим количеством.
   *
   * Отдельно от findByGame: тот отдаёт весь набор для анализа, а интерфейсу
   * нужна страница. Загружать тысячи отзывов ради двадцати недопустимо.
   *
   * platformSlug не задан — учитываются все платформы.
   */
  listPaged(params: {
    gameId: string;
    kind: ReviewKind;
    platformSlug?: string;
    limit: number;
    offset: number;
  }): Promise<{ items: readonly StoredReview[]; total: number }>;
}

export interface ReviewSnapshotRepository {
  find(params: {
    gameId: string;
    kind: ReviewKind;
    platformSlug: string;
    tx?: TxContext;
  }): Promise<ReviewSnapshot | null>;

  /** Создаёт или обновляет снимок по (game, kind, platform). */
  save(snapshot: ReviewSnapshot, tx?: TxContext): Promise<void>;
}
