/**
 * Доменная модель обработки: план дня и реестр claim.
 *
 * Реализует требования ADR-0002 (реестр processing day) и ADR-0004
 * (claim / lease / recovery).
 */

import type { GameSource } from '../../catalog/domain/game.js';

/** Фаза выборки игр в течение суток. */
export type ProcessingPhase = 'new_releases' | 'browse' | 'exhausted';

/** Жизненный цикл заявки на обработку игры. */
export type ClaimStatus = 'pending' | 'claimed' | 'done' | 'failed';

/** Стадии обработки одной игры. */
export type StageName =
  | 'fetchGame'
  | 'fetchReviews'
  | 'summarize'
  | 'similar'
  | 'youtube';

export type StageStatus = 'pending' | 'done' | 'failed' | 'skipped';

export interface StageState {
  readonly status: StageStatus;
  readonly at?: string;
  readonly error?: string;
  readonly reason?: string;
}

/** Прогресс по стадиям — позволяет возобновить частично выполненную работу. */
export type StageMap = Partial<Record<StageName, StageState>>;

/** План на календарные сутки. */
export interface ProcessingDay {
  readonly day: string;
  readonly phase: ProcessingPhase;
  /** Курсор страницы — подсказка, не источник истины (ADR-0002). */
  readonly browsePage: number;
  readonly newReleasesDone: boolean;
  readonly claimedCount: number;
}

/** Заявка на обработку игры в конкретные сутки. */
export interface DailyClaim {
  readonly processingDay: string;
  readonly source: GameSource;
  readonly sourceSlug: string;
  readonly gameId: string | null;
  readonly runId: string | null;
  readonly status: ClaimStatus;
  readonly claimedAt: Date | null;
  readonly leaseUntil: Date | null;
  readonly attempts: number;
  readonly stages: StageMap;
  readonly lastError: string | null;
  readonly completedAt: Date | null;
}

/** Критичные стадии: их провал означает неуспех обработки игры.
 *  Остальные — обогащающие, их сбой не мешает сохранить и показать игру. */
const CRITICAL_STAGES: readonly StageName[] = ['fetchGame', 'fetchReviews'];

export function isCriticalStage(stage: StageName): boolean {
  return CRITICAL_STAGES.includes(stage);
}

/**
 * Определяет, нужно ли выполнять стадию.
 * Уже завершённые и намеренно пропущенные стадии не повторяются —
 * это и есть возобновление частично выполненной работы (ADR-0004).
 */
export function shouldRunStage(stages: StageMap, stage: StageName): boolean {
  const state = stages[stage];
  if (!state) return true;
  return state.status !== 'done' && state.status !== 'skipped';
}

/** Первая незавершённая стадия в заданном порядке. */
export function nextStage(
  stages: StageMap,
  order: readonly StageName[],
): StageName | null {
  return order.find((stage) => shouldRunStage(stages, stage)) ?? null;
}

/**
 * Исчерпаны ли попытки. При достижении предела заявка переводится в 'failed',
 * чтобы не занимать место в батче, оставаясь видимой в мониторинге.
 */
export function hasExhaustedAttempts(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts;
}

/** Истёк ли срок аренды — признак того, что воркер, вероятно, упал. */
export function isLeaseExpired(claim: DailyClaim, now: Date): boolean {
  if (claim.status !== 'claimed' || claim.leaseUntil === null) return false;
  return claim.leaseUntil.getTime() < now.getTime();
}

/**
 * Вычисляет календарный день в заданной таймзоне.
 *
 * Используется конфигурируемая зона, а не время сервера: иначе граница суток
 * зависела бы от хоста и «начать день заново» срабатывало бы непредсказуемо
 * (ADR-0002, решение OQ-1).
 */
export function resolveProcessingDay(now: Date, timeZone: string): string {
  // en-CA даёт формат YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
