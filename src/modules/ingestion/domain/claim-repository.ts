/**
 * Порты репозиториев обработки: план дня и реестр claim (ADR-0002, ADR-0004).
 */

import type { GameSource } from '../../catalog/domain/game.js';
import type {
  ClaimStatus,
  DailyClaim,
  ProcessingDay,
  ProcessingPhase,
  StageMap,
  StageName,
  StageState,
} from './claim.js';

export interface ClaimCandidate {
  readonly source: GameSource;
  readonly sourceSlug: string;
}

export interface ProcessingDayUpdate {
  readonly phase?: ProcessingPhase;
  readonly browsePage?: number;
  readonly newReleasesDone?: boolean;
}

export interface ProcessingDayRepository {
  /**
   * Возвращает план на указанные сутки, создавая его при отсутствии.
   * Отсутствие строки = новый день, цикл начинается заново (ADR-0002).
   * Создание идемпотентно: гонка двух воркеров безопасна.
   */
  ensureDay(day: string): Promise<ProcessingDay>;

  update(day: string, patch: ProcessingDayUpdate): Promise<ProcessingDay>;

  find(day: string): Promise<ProcessingDay | null>;
}

/** Счётчики заявок одного запуска для мониторинга. */
export interface RunClaimCounters {
  readonly total: number;
  readonly succeeded: number;
  readonly partial: number;
  readonly failed: number;
  /** Заявки, взятые в работу и не завершённые к моменту запроса. */
  readonly inProgress: number;
}

/** Итоги одной стадии в рамках запуска. */
export interface RunStageCounters {
  readonly stage: string;
  readonly done: number;
  readonly failed: number;
  readonly skipped: number;
  readonly pending: number;
}

export interface ClaimRepository {
  /**
   * Атомарно заявляет игры на обработку.
   *
   * Реализуется через INSERT ... ON CONFLICT DO NOTHING RETURNING:
   * возвращаются только те кандидаты, которые захвачены ИМЕННО этим вызовом.
   * Уже заявленные или обработанные сегодня — не возвращаются.
   *
   * Это единственный механизм, обеспечивающий одновременно идемпотентность
   * и защиту от гонок (ADR-0004).
   */
  claimBatch(params: {
    day: string;
    runId: string;
    candidates: readonly ClaimCandidate[];
    leaseMinutes: number;
    limit: number;
  }): Promise<readonly DailyClaim[]>;

  /** Переводит заявку в 'done'. */
  markDone(params: {
    day: string;
    source: GameSource;
    sourceSlug: string;
    gameId: string | null;
    stages: StageMap;
  }): Promise<void>;

  /** Переводит заявку в 'failed' с фиксацией причины. */
  markFailed(params: {
    day: string;
    source: GameSource;
    sourceSlug: string;
    error: string;
    stages: StageMap;
  }): Promise<void>;

  /** Сохраняет результат одной стадии — основа возобновления работы. */
  recordStage(params: {
    day: string;
    source: GameSource;
    sourceSlug: string;
    stage: StageName;
    state: StageState;
  }): Promise<void>;

  /**
   * Продлевает аренду работающего воркера.
   *
   * Продление УСЛОВНО: выполняется только если заявка всё ещё захвачена,
   * её аренда не истекла И она принадлежит указанному запуску.
   *
   * Без этих условий возможна гонка: reaper вернул заявку в пул, следующий
   * запуск её перезахватил, а старый воркер продлил бы аренду уже чужой
   * работе — и обе обработки шли бы параллельно.
   *
   * Возвращает true, если аренда действительно продлена. false означает,
   * что заявка воркеру больше не принадлежит и работу следует прекратить.
   */
  extendLease(params: {
    day: string;
    source: GameSource;
    sourceSlug: string;
    leaseMinutes: number;
    /** Владелец заявки; продление чужой аренды невозможно. */
    runId: string;
  }): Promise<boolean>;

  /**
   * Возвращает в пул заявки с истёкшей арендой (reaper).
   *
   * ОБНОВЛЯЕТ существующие строки, а не вставляет новые — требование
   * «retry без duplicate claim». Возвращает число восстановленных записей.
   * При исчерпании попыток заявка переводится в 'failed'.
   */
  reapExpiredLeases(params: { now: Date; maxAttempts: number }): Promise<{
    revived: number;
    failed: number;
  }>;

  find(
    day: string,
    source: GameSource,
    sourceSlug: string,
  ): Promise<DailyClaim | null>;

  /** Слаги, уже заявленные за сутки, — для фильтрации кандидатов. */
  findClaimedSlugs(day: string, source: GameSource): Promise<readonly string[]>;

  countByStatus(day: string): Promise<Record<ClaimStatus, number>>;

  /**
   * Итоги одного запуска в терминах интерфейса.
   *
   * `partial` — производная величина, а не статус в БД: заявка выполнена,
   * но необязательная стадия не удалась либо была пропущена. Домен такого
   * статуса не знает и знать не должен (решение OQ-3A-4).
   */
  countByRun(runId: string): Promise<RunClaimCounters>;

  /**
   * Итоги по стадиям одного запуска.
   *
   * Нужны интерфейсу мониторинга: по ним видно, на какой именно стадии
   * останавливается обработка. Счётчики заявок этого не показывают.
   */
  countStagesByRun(runId: string): Promise<readonly RunStageCounters[]>;
}
