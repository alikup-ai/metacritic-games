import type {
  GameRepository,
  GamePlatformRepository,
  GameSortField,
} from '../../modules/catalog/domain/game-repository.js';
import type { ReviewRepository } from '../../modules/reviews/domain/review-ports.js';
import type { ReviewSummaryRepository } from '../../modules/analysis/domain/summary.js';
import type { ReviewSummary } from '../../modules/analysis/domain/summary.js';
import type { FindSimilarGamesUseCase } from '../../modules/similarity/application/find-similar-games.js';
import type { VideoInsightRepository } from '../../modules/video/domain/video-ports.js';
import type { EnrichGameVideoUseCase } from '../../modules/video/application/enrich-game-video.js';
import {
  toAnalysisDto,
  toGameDetailDto,
  toGameListItemDto,
  toPagination,
  toReviewDto,
  type GameAnalysisDto,
  type GameDetailDto,
  type GameListItemDto,
  toVideoInsightDto,
  EMPTY_VIDEO_INSIGHT,
  type PagedDto,
  type PlatformOptionDto,
  type ReviewDto,
  type VideoInsightDto,
} from '../dto/index.js';
import { ApiError } from '../http/errors.js';
import type { Handler } from '../http/router.js';
import {
  parseEnum,
  parsePage,
  parsePageSize,
  parsePlatformSlug,
  parseSearch,
  parseUuid,
  REVIEW_KINDS,
  SORT_FIELDS,
  SORT_ORDERS,
} from '../http/validation.js';

/**
 * Маршруты каталога.
 *
 * Обращаются к портам приложения, а не к базе. Бизнес-правила здесь не
 * повторяются: фильтрация по активным платформам, отбор и подсчёт уже
 * реализованы в слое доступа к данным.
 */

export interface CatalogDeps {
  readonly games: GameRepository;
  readonly platforms: GamePlatformRepository;
  readonly reviews: ReviewRepository;
  readonly summaries: ReviewSummaryRepository;
  /** Подбор похожих игр; null отключает раздел. */
  readonly similar: FindSimilarGamesUseCase | null;
  /** Обогащение видеообзорами; null отключает раздел. */
  readonly videoInsights: VideoInsightRepository | null;
  /** Ручной запуск обогащения; null, если функция выключена. */
  readonly enrichVideo: EnrichGameVideoUseCase | null;
  readonly pageDefaults: { defaultSize: number; maxSize: number };
}

export function createListGamesHandler(deps: CatalogDeps): Handler {
  return async (context) => {
    const page = parsePage(context.query.page);
    const pageSize = parsePageSize(context.query.pageSize, deps.pageDefaults);
    const search = parseSearch(context.query.q);
    const platform = parsePlatformSlug(context.query.platform);

    // Поле сортировки берётся из белого списка: имя колонки от клиента
    // в запрос попасть не может.
    const sort = parseEnum(context.query.sort, SORT_FIELDS, 'sort', 'metascore');
    const order = parseEnum(context.query.order, SORT_ORDERS, 'order', 'desc');

    const result = await deps.games.list({
      ...(search !== undefined ? { search } : {}),
      ...(platform !== undefined ? { platformSlugs: [platform] } : {}),
      sortBy: sort as GameSortField,
      sortDirection: order,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    const body: PagedDto<GameListItemDto> = {
      items: result.items.map(toGameListItemDto),
      pagination: toPagination({ page, pageSize, total: result.total }),
    };

    return { status: 200, body };
  };
}

export function createGetGameHandler(deps: CatalogDeps): Handler {
  return async (context) => {
    const id = parseUuid(context.params.id, 'id');

    const game = await deps.games.findById(id);
    if (!game) {
      throw new ApiError('GAME_NOT_FOUND', 'Игра не найдена');
    }

    // Берутся все платформы, включая отключённые: DTO само отбирает
    // активные, а знание о жизненном цикле остаётся в одном месте.
    const platforms = await deps.platforms.findAllByGameId(game.id);

    // Сбой подбора не должен ломать карточку игры: это дополнение,
    // а не основная часть сведений.
    let similar: Awaited<ReturnType<FindSimilarGamesUseCase['execute']>> = [];
    if (deps.similar) {
      similar = await deps.similar.execute({ gameId: game.id }).catch(() => []);
    }

    const body: GameDetailDto = toGameDetailDto(game, platforms, similar);
    return { status: 200, body };
  };
}

export function createListPlatformsHandler(deps: CatalogDeps): Handler {
  return async () => {
    // Репозиторий отдаёт только активные платформы: отключённые не
    // предлагаются как вариант фильтра (ADR-0011).
    const platforms = await deps.platforms.listDistinctPlatforms();

    const body: { items: readonly PlatformOptionDto[] } = {
      items: platforms.map((p) => ({ slug: p.slug, name: p.name })),
    };

    return { status: 200, body };
  };
}

/**
 * Выбирает резюме для показа среди платформ.
 *
 * Резюме хранятся по (игра, разновидность, платформа). Интерфейсу нужно
 * одно на разновидность, поэтому предпочтение отдаётся успешному
 * с наибольшим числом проанализированных отзывов: это самое
 * представительное из имеющихся.
 */
function pickSummary(
  summaries: readonly ReviewSummary[],
  kind: 'critic' | 'user',
  platform: string | undefined,
): ReviewSummary | null {
  const matching = summaries.filter(
    (s) => s.kind === kind && (platform === undefined || s.platformSlug === platform),
  );
  if (matching.length === 0) return null;

  const ranked = [...matching].sort((a, b) => {
    // Успешный анализ всегда предпочтительнее неуспешного.
    const okA = a.status === 'ok' ? 1 : 0;
    const okB = b.status === 'ok' ? 1 : 0;
    if (okA !== okB) return okB - okA;
    if (a.analyzedCount !== b.analyzedCount) return b.analyzedCount - a.analyzedCount;
    // Устойчивый порядок при равенстве.
    return a.platformSlug.localeCompare(b.platformSlug);
  });

  return ranked[0] ?? null;
}

export function createGetAnalysisHandler(deps: CatalogDeps): Handler {
  return async (context) => {
    const id = parseUuid(context.params.id, 'id');
    const platform = parsePlatformSlug(context.query.platform);

    const game = await deps.games.findById(id);
    if (!game) {
      throw new ApiError('GAME_NOT_FOUND', 'Игра не найдена');
    }

    const summaries = await deps.summaries.findByGame(game.id);

    const critic = pickSummary(summaries, 'critic', platform);
    const user = pickSummary(summaries, 'user', platform);

    // Критики и пользователи никогда не смешиваются: это разные
    // аудитории и разные шкалы оценок.
    const body: GameAnalysisDto = {
      gameId: game.id,
      critic: critic ? toAnalysisDto(critic) : null,
      user: user ? toAnalysisDto(user) : null,
    };

    return { status: 200, body };
  };
}

export function createListReviewsHandler(deps: CatalogDeps): Handler {
  return async (context) => {
    const id = parseUuid(context.params.id, 'id');
    const kind = parseEnum(context.query.kind, REVIEW_KINDS, 'kind', 'critic');
    const platform = parsePlatformSlug(context.query.platform);
    const page = parsePage(context.query.page);
    const pageSize = parsePageSize(context.query.pageSize, deps.pageDefaults);

    const game = await deps.games.findById(id);
    if (!game) {
      throw new ApiError('GAME_NOT_FOUND', 'Игра не найдена');
    }

    const result = await deps.reviews.listPaged({
      gameId: game.id,
      kind,
      ...(platform !== undefined ? { platformSlug: platform } : {}),
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    const body: PagedDto<ReviewDto> = {
      items: result.items.map(toReviewDto),
      pagination: toPagination({ page, pageSize, total: result.total }),
    };

    return { status: 200, body };
  };
}

/**
 * Обогащение игры видеообзором.
 *
 * Отсутствие обогащения — не ошибка: возвращается структурированный
 * статус 'none', а не 404 и не 500.
 */
export function createGetVideoHandler(deps: CatalogDeps): Handler {
  return async (context) => {
    const id = parseUuid(context.params.id, 'id');

    const game = await deps.games.findById(id);
    if (!game) {
      throw new ApiError('GAME_NOT_FOUND', 'Игра не найдена');
    }

    if (!deps.videoInsights) {
      return { status: 200, body: EMPTY_VIDEO_INSIGHT };
    }

    const insight = await deps.videoInsights.find(game.id);
    const body: VideoInsightDto = insight
      ? toVideoInsightDto(insight)
      : EMPTY_VIDEO_INSIGHT;

    return { status: 200, body };
  };
}

/**
 * Ручной запуск обогащения.
 *
 * Отдельное действие, а не часть открытия страницы: обращение к YouTube
 * и модели стоит денег и времени, и выполнять его при каждом просмотре
 * недопустимо.
 */
export function createEnrichVideoHandler(deps: CatalogDeps): Handler {
  return async (context) => {
    const id = parseUuid(context.params.id, 'id');

    const game = await deps.games.findById(id);
    if (!game) {
      throw new ApiError('GAME_NOT_FOUND', 'Игра не найдена');
    }

    if (!deps.enrichVideo) {
      throw new ApiError('SERVICE_UNAVAILABLE', 'Обогащение видео выключено');
    }

    const result = await deps.enrichVideo.execute({
      gameId: game.id,
      gameTitle: game.title,
    });

    // Даже неуспешный исход возвращается как состояние: сбой YouTube или
    // отсутствие субтитров не являются ошибкой запроса.
    return { status: 202, body: result };
  };
}
