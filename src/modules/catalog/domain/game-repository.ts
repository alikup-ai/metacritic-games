/**
 * Порты репозиториев каталога.
 *
 * Объявлены в domain, реализуются в infrastructure (ADR-0001).
 * Здесь нет ни SQL, ни типов драйвера БД.
 *
 * Методы выражают намерение предметной области («заменить снимок платформ»),
 * а не механику хранения («выполнить запрос»).
 */

import type { Game, GamePlatform, GameUpsertInput, ScoreScope } from './game.js';
import type { TxContext } from './unit-of-work.js';

/** Данные одной платформы для записи. */
export interface GamePlatformInput {
  readonly platformSlug: string;
  readonly platformName: string;
  /** null означает 'tbd' — платформа известна, оценки ещё нет. Не 0. */
  readonly metascore: number | null;
  readonly metascoreScope: ScoreScope;
  readonly userscore: number | null;
  readonly userscoreScope: ScoreScope;
  readonly criticCount: number | null;
  readonly userCount: number | null;
}

/** Платформа с полями жизненного цикла (ADR-0011). */
export interface StoredGamePlatform extends GamePlatform {
  readonly isActive: boolean;
  readonly lastSeenAt: Date;
  readonly deactivatedAt: Date | null;
}

/** Итог синхронизации снимка платформ. */
export interface PlatformSyncResult {
  readonly created: number;
  readonly updated: number;
  readonly deactivated: number;
  readonly reactivated: number;
  /** true, если снимок был пуст и отключение намеренно не выполнялось. */
  readonly skippedDeactivation: boolean;
}

export type GameSortField = 'metascore' | 'userscore' | 'releaseDate' | 'title';
export type SortDirection = 'asc' | 'desc';

export interface GameListQuery {
  readonly search?: string;
  readonly platformSlugs?: readonly string[];
  readonly sortBy?: GameSortField;
  readonly sortDirection?: SortDirection;
  readonly limit?: number;
  readonly offset?: number;
}

export interface GameListResult {
  readonly items: readonly Game[];
  readonly total: number;
}

/** Результат upsert: важно знать, была игра создана или обновлена. */
/** Игра с платформами для подбора похожих. */
export interface SimilarityCandidateRow {
  readonly id: string;
  readonly title: string;
  readonly coverUrl: string | null;
  readonly releaseDate: string | null;
  readonly developer: string | null;
  readonly publishers: readonly string[];
  readonly genres: readonly string[];
  readonly metascore: number | null;
  readonly userscore: number | null;
  readonly platforms: readonly string[];
}

export interface GameUpsertResult {
  readonly game: Game;
  readonly created: boolean;
}

export interface GameRepository {
  /**
   * Создаёт или обновляет игру по natural key (source, source_slug).
   *
   * Идемпотентен: повторный вызов с тем же ключом обновляет существующую
   * запись и никогда не создаёт вторую. `first_seen_at` сохраняется.
   *
   * tx позволяет выполнить операцию внутри общей транзакции вместе с
   * синхронизацией платформ.
   */
  upsert(input: GameUpsertInput, tx?: TxContext): Promise<GameUpsertResult>;

  findById(id: string, tx?: TxContext): Promise<Game | null>;

  findBySourceSlug(
    source: string,
    sourceSlug: string,
    tx?: TxContext,
  ): Promise<Game | null>;

  list(query: GameListQuery): Promise<GameListResult>;

  /**
   * Игры вместе со слагами активных платформ — для подбора похожих.
   *
   * Отдельный метод, а не list + перебор платформ: иначе на каждую игру
   * шёл бы свой запрос за платформами.
   *
   * excludeGameId исключает саму игру ещё на уровне запроса.
   */
  listForSimilarity(params: {
    excludeGameId: string;
    limit: number;
  }): Promise<readonly SimilarityCandidateRow[]>;

  /** Та же форма для одной игры — исходной точки подбора. */
  findForSimilarity(gameId: string): Promise<SimilarityCandidateRow | null>;
}

export interface GamePlatformRepository {
  /**
   * Приводит набор платформ игры в соответствие со снимком источника.
   *
   * Стратегия (ADR-0011):
   * - платформа из снимка отсутствует в БД -> создаётся;
   * - есть в обоих -> обновляется, отмечается как увиденная;
   * - есть в БД, но нет в снимке -> ОТКЛЮЧАЕТСЯ (is_active = false),
   *   данные сохраняются; молчаливое удаление запрещено;
   * - снимок пуст -> отключение НЕ выполняется, чтобы сбой парсера не
   *   обнулил каталог.
   */
  replacePlatformSnapshot(
    gameId: string,
    platforms: readonly GamePlatformInput[],
    tx?: TxContext,
  ): Promise<PlatformSyncResult>;

  /** Только активные платформы — то, что показывается пользователю. */
  findActiveByGameId(gameId: string, tx?: TxContext): Promise<readonly StoredGamePlatform[]>;

  /** Все платформы, включая отключённые, — для диагностики и аудита. */
  findAllByGameId(gameId: string, tx?: TxContext): Promise<readonly StoredGamePlatform[]>;

  /** Платформы, встречающиеся в каталоге, — для фильтра в интерфейсе. */
  listDistinctPlatforms(): Promise<readonly { slug: string; name: string }[]>;
}
