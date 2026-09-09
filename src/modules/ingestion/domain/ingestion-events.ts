/**
 * События процесса ingestion.
 *
 * Порт объявлен в domain, чтобы application-слой мог сообщать о ходе работы,
 * не завися от способа доставки (лог, БД, SSE). Реализация подключается в
 * composition root.
 */

import type { DeveloperStatus, GameSource } from '../../catalog/domain/game.js';

export type IngestionEventType =
  | 'run_started'
  | 'run_completed'
  | 'run_failed'
  | 'run_skipped'
  | 'claim_created'
  | 'claim_skipped'
  | 'claim_recovered'
  | 'game_processing_started'
  | 'game_processing_completed'
  | 'game_processing_failed'
  | 'stage_finished'
  | 'ingestion_started'
  | 'ingestion_succeeded'
  | 'ingestion_failed'
  | 'game_created'
  | 'game_updated'
  | 'platforms_synchronized'
  | 'userscore_fetched'
  | 'userscore_unavailable';

interface BaseEvent {
  readonly source: GameSource;
  readonly sourceSlug: string;
}

export interface IngestionStartedEvent extends BaseEvent {
  readonly type: 'ingestion_started';
}

export interface IngestionSucceededEvent extends BaseEvent {
  readonly type: 'ingestion_succeeded';
  readonly gameId: string;
  readonly durationMs: number;
  readonly created: boolean;
}

export interface IngestionFailedEvent extends BaseEvent {
  readonly type: 'ingestion_failed';
  readonly durationMs: number;
  readonly errorCategory: string;
  readonly errorMessage: string;
  readonly stage: 'fetch' | 'persist';
}

export interface GameCreatedEvent extends BaseEvent {
  readonly type: 'game_created';
  readonly gameId: string;
  readonly title: string;
  readonly developerStatus: DeveloperStatus;
}

export interface GameUpdatedEvent extends BaseEvent {
  readonly type: 'game_updated';
  readonly gameId: string;
  readonly title: string;
  readonly developerStatus: DeveloperStatus;
}

export interface PlatformsSynchronizedEvent extends BaseEvent {
  readonly type: 'platforms_synchronized';
  readonly gameId: string;
  readonly created: number;
  readonly updated: number;
  readonly deactivated: number;
  readonly reactivated: number;
  readonly skippedDeactivation: boolean;
}

export interface UserscoreFetchedEvent extends BaseEvent {
  readonly type: 'userscore_fetched';
  readonly userscore: number;
}

export interface UserscoreUnavailableEvent extends BaseEvent {
  readonly type: 'userscore_unavailable';
  /** failed — запрос не удался; absent — источник не публикует значение. */
  readonly reason: 'failed' | 'absent' | 'disabled';
  readonly errorCategory?: string;
}

/** События уровня запуска обработки (Phase 1C). */
export interface RunStartedEvent {
  readonly type: 'run_started';
  readonly runId: string;
  readonly processingDay: string;
  readonly trigger: 'cron' | 'manual';
}

export interface RunCompletedEvent {
  readonly type: 'run_completed';
  readonly runId: string;
  readonly processingDay: string;
  readonly claimed: number;
  readonly processed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly pagesScanned: number;
  readonly strategy: string;
  readonly stopReason: string;
  readonly durationMs: number;
}

export interface RunFailedEvent {
  readonly type: 'run_failed';
  readonly runId: string;
  readonly processingDay: string;
  readonly errorCategory: string;
  readonly errorMessage: string;
  readonly durationMs: number;
}

/** Запуск не начат: другой запуск уже удерживает блокировку. */
export interface RunSkippedEvent {
  readonly type: 'run_skipped';
  readonly reason: 'already_running';
  readonly processingDay: string;
}

export interface ClaimCreatedEvent {
  readonly type: 'claim_created';
  readonly runId: string;
  readonly processingDay: string;
  readonly sourceSlug: string;
  readonly attempts: number;
}

export interface ClaimSkippedEvent {
  readonly type: 'claim_skipped';
  readonly runId: string;
  readonly processingDay: string;
  readonly count: number;
  readonly reason: 'already_claimed_today';
}

export interface ClaimRecoveredEvent {
  readonly type: 'claim_recovered';
  readonly processingDay: string;
  readonly revived: number;
  readonly failed: number;
}

export interface GameProcessingStartedEvent {
  readonly type: 'game_processing_started';
  readonly runId: string;
  readonly sourceSlug: string;
  readonly attempts: number;
}

export interface GameProcessingCompletedEvent {
  readonly type: 'game_processing_completed';
  readonly runId: string;
  readonly sourceSlug: string;
  readonly gameId: string;
  readonly durationMs: number;
}

export interface GameProcessingFailedEvent {
  readonly type: 'game_processing_failed';
  readonly runId: string;
  readonly sourceSlug: string;
  readonly errorCategory: string;
  readonly errorMessage: string;
  readonly attempts: number;
}

/**
 * Завершение стадии обработки игры.
 *
 * Единственное добавленное событие: без него исход отдельной стадии не
 * виден снаружи — заявка хранит итог, но не момент и не длительность.
 *
 * В событие НЕ попадают: тексты отзывов, промпт, ответ модели, ключи.
 * Только имя стадии, исход, причина и длительность.
 */
export interface StageFinishedEvent {
  readonly type: 'stage_finished';
  readonly runId: string;
  readonly sourceSlug: string;
  readonly stage: string;
  readonly outcome: 'success' | 'partial' | 'failed' | 'skipped';
  /** Причина пропуска либо категория ошибки; произвольного текста нет. */
  readonly reason: string | null;
  readonly durationMs: number;
}

export type IngestionEvent =
  | RunStartedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunSkippedEvent
  | ClaimCreatedEvent
  | ClaimSkippedEvent
  | ClaimRecoveredEvent
  | GameProcessingStartedEvent
  | GameProcessingCompletedEvent
  | GameProcessingFailedEvent
  | StageFinishedEvent
  | IngestionStartedEvent
  | IngestionSucceededEvent
  | IngestionFailedEvent
  | GameCreatedEvent
  | GameUpdatedEvent
  | PlatformsSynchronizedEvent
  | UserscoreFetchedEvent
  | UserscoreUnavailableEvent;

/** Приёмник событий ingestion. */
export interface IngestionEventSink {
  emit(event: IngestionEvent): void;
}

/** Приёмник, не делающий ничего, — для тестов и отключённой телеметрии. */
export const noopEventSink: IngestionEventSink = {
  emit: () => undefined,
};

/** Собирает события в память — удобно для проверок в тестах. */
export class RecordingEventSink implements IngestionEventSink {
  readonly events: IngestionEvent[] = [];

  emit(event: IngestionEvent): void {
    this.events.push(event);
  }

  ofType<T extends IngestionEventType>(
    type: T,
  ): Extract<IngestionEvent, { type: T }>[] {
    return this.events.filter(
      (event): event is Extract<IngestionEvent, { type: T }> => event.type === type,
    );
  }
}
