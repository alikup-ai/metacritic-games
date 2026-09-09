import type {
  GamePlatformInput,
  GamePlatformRepository,
  GameRepository,
} from '../../catalog/domain/game-repository.js';
import type { UnitOfWork } from '../../catalog/domain/unit-of-work.js';
import type { GameUpsertInput } from '../../catalog/domain/game.js';
import type {
  GameCatalogSource,
  NormalizedGame,
} from '../domain/catalog-source.js';
import { isIngestionError } from '../domain/ingestion-errors.js';
import {
  noopEventSink,
  type IngestionEventSink,
} from '../domain/ingestion-events.js';

/**
 * Ingestion одной игры: получение из источника и сохранение в каталог.
 *
 * Слой application работает только с портами. Здесь нет ни cheerio, ни HTML,
 * ни HTTP, ни SQL — они спрятаны за GameCatalogSource и репозиториями
 * (ADR-0001).
 *
 * Порядок операций (ADR-0011):
 *   1) сеть — ВНЕ транзакции;
 *   2) транзакция: upsert игры + синхронизация платформ;
 *   3) при ошибке — откат, частичного сохранения не остаётся.
 */

export interface IngestGameDeps {
  readonly catalogSource: GameCatalogSource;
  readonly games: GameRepository;
  readonly platforms: GamePlatformRepository;
  readonly unitOfWork: UnitOfWork;
  readonly events?: IngestionEventSink;
  /** Источник времени — подменяется в тестах. */
  readonly now?: () => number;
}

export interface IngestGameParams {
  readonly sourceSlug: string;
  readonly signal?: AbortSignal;
}

export interface IngestGameResult {
  readonly gameId: string;
  readonly created: boolean;
  readonly platformsCreated: number;
  readonly platformsUpdated: number;
  readonly platformsDeactivated: number;
  readonly platformsReactivated: number;
  readonly durationMs: number;
}

/**
 * Преобразует нормализованные данные источника в модель хранения.
 *
 * Инварианты, которые обязаны сохраниться при переносе:
 * - developer и publishers остаются РАЗДЕЛЬНЫМИ полями; издатель никогда не
 *   подставляется вместо разработчика (ADR-0003);
 * - metascore = null означает 'tbd' и не превращается в 0;
 * - userscore не разносится по платформам (ADR-0008).
 */
export function toGameUpsertInput(game: NormalizedGame): GameUpsertInput {
  return {
    source: game.source,
    sourceSlug: game.sourceSlug,
    sourceUrl: game.canonicalUrl,
    parserVersion: game.parserVersion,
    title: game.title,
    description: game.description,
    coverUrl: game.coverImageUrl,
    trailerUrl: game.videoUrl,
    // Разработчик — только из собственного поля источника
    developer: game.developer,
    developerStatus: game.developerStatus,
    // Издатели хранятся отдельно и не участвуют в вычислении developer
    publishers: game.publishers,
    genres: game.genres,
    releaseDate: game.releaseDate,
    metascoreOverall: game.metascoreOverall,
    userscoreOverall: game.userscoreOverall,
  };
}

export function toPlatformInputs(game: NormalizedGame): GamePlatformInput[] {
  return game.platforms.map((platform) => ({
    platformSlug: platform.platform,
    platformName: platform.platformName,
    // null сохраняется как null: 'tbd' не является нулевой оценкой
    metascore: platform.metascore,
    metascoreScope: platform.metascoreScope,
    // Общий Userscore не размножается по платформам
    userscore: platform.userscore,
    userscoreScope: platform.userscoreScope,
    criticCount: platform.criticCount,
    userCount: null,
  }));
}

export class IngestGameUseCase {
  private readonly events: IngestionEventSink;
  private readonly now: () => number;

  constructor(private readonly deps: IngestGameDeps) {
    this.events = deps.events ?? noopEventSink;
    this.now = deps.now ?? (() => Date.now());
  }

  async execute(params: IngestGameParams): Promise<IngestGameResult> {
    const startedAt = this.now();
    const source = this.deps.catalogSource.source;
    const sourceSlug = params.sourceSlug.trim().toLowerCase();

    this.events.emit({ type: 'ingestion_started', source, sourceSlug });

    // --- Шаг 1: сеть. Выполняется ВНЕ транзакции, чтобы медленный HTTP
    // не удерживал соединение с БД и не порождал распределённых транзакций.
    let normalized: NormalizedGame;
    try {
      normalized = await this.deps.catalogSource.fetchGame({
        sourceSlug,
        ...(params.signal ? { signal: params.signal } : {}),
      });
    } catch (error) {
      this.emitFailure(source, sourceSlug, startedAt, error, 'fetch');
      throw error;
    }

    this.emitUserscoreOutcome(source, sourceSlug, normalized);

    // --- Шаг 2: транзакция. Игра и её платформы фиксируются вместе.
    try {
      const result = await this.deps.unitOfWork.withTransaction(async (tx) => {
        const upsert = await this.deps.games.upsert(toGameUpsertInput(normalized), tx);

        const sync = await this.deps.platforms.replacePlatformSnapshot(
          upsert.game.id,
          toPlatformInputs(normalized),
          tx,
        );

        return { upsert, sync };
      });

      const { upsert, sync } = result;

      this.events.emit({
        type: upsert.created ? 'game_created' : 'game_updated',
        source,
        sourceSlug,
        gameId: upsert.game.id,
        title: upsert.game.title,
        developerStatus: upsert.game.developerStatus,
      });

      this.events.emit({
        type: 'platforms_synchronized',
        source,
        sourceSlug,
        gameId: upsert.game.id,
        created: sync.created,
        updated: sync.updated,
        deactivated: sync.deactivated,
        reactivated: sync.reactivated,
        skippedDeactivation: sync.skippedDeactivation,
      });

      const durationMs = this.now() - startedAt;
      this.events.emit({
        type: 'ingestion_succeeded',
        source,
        sourceSlug,
        gameId: upsert.game.id,
        durationMs,
        created: upsert.created,
      });

      return {
        gameId: upsert.game.id,
        created: upsert.created,
        platformsCreated: sync.created,
        platformsUpdated: sync.updated,
        platformsDeactivated: sync.deactivated,
        platformsReactivated: sync.reactivated,
        durationMs,
      };
    } catch (error) {
      // Транзакция откачена: частично сохранённых данных не остаётся.
      this.emitFailure(source, sourceSlug, startedAt, error, 'persist');
      throw error;
    }
  }

  /**
   * Сообщает об исходе получения Userscore.
   *
   * Userscore — обогащение: его отсутствие не влияет на успех ingestion.
   * Различаются «источник не публикует значение» и «запрос не выполнялся»
   * (ADR-0011).
   */
  private emitUserscoreOutcome(
    source: NormalizedGame['source'],
    sourceSlug: string,
    game: NormalizedGame,
  ): void {
    if (game.userscoreOverall !== null) {
      this.events.emit({
        type: 'userscore_fetched',
        source,
        sourceSlug,
        userscore: game.userscoreOverall,
      });
      return;
    }

    // Причина берётся из источника: сбой запроса, отсутствие значения и
    // выключенную догрузку нужно различать — реакция на них разная.
    this.events.emit({
      type: 'userscore_unavailable',
      source,
      sourceSlug,
      reason: game.userscoreStatus === 'fetched' ? 'absent' : game.userscoreStatus,
    });
  }

  private emitFailure(
    source: NormalizedGame['source'],
    sourceSlug: string,
    startedAt: number,
    error: unknown,
    stage: 'fetch' | 'persist',
  ): void {
    this.events.emit({
      type: 'ingestion_failed',
      source,
      sourceSlug,
      durationMs: this.now() - startedAt,
      errorCategory: isIngestionError(error) ? error.category : 'unknown',
      errorMessage: error instanceof Error ? error.message : String(error),
      stage,
    });
  }
}
