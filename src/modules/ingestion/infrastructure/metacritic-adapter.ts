import type {
  FetchGameParams,
  FetchListingParams,
  GameCatalogSource,
  NormalizedGame,
  NormalizedListingPage,
  UserscoreStatus,
} from '../domain/catalog-source.js';
import type { GameSource } from '../../catalog/domain/game.js';
import { IngestionError, isIngestionError } from '../domain/ingestion-errors.js';
import { silentLogger, type Logger } from '../../../shared/logging/logger.js';
import type { MetacriticHttpClient } from './metacritic-http-client.js';
import {
  parseBrowseListing,
  parseNewReleasesListing,
} from './parsers/listing-parser.js';
import {
  parseGameDetail,
  parseOverallUserscore,
} from './parsers/game-detail-parser.js';

/**
 * Адаптер Metacritic — реализация порта GameCatalogSource.
 *
 * Отвечает за оркестрацию: получить страницу через HTTP-клиент и передать
 * её парсеру. Ни разбора HTML, ни сетевой логики здесь нет — они разнесены
 * по отдельным модулям, чтобы парсеры тестировались на фикстурах без сети.
 */

export interface MetacriticAdapterOptions {
  readonly http: MetacriticHttpClient;
  readonly logger?: Logger;
  /**
   * Догружать общий Userscore со страницы отзывов.
   * Это дополнительный запрос на игру, поэтому поведение управляется явно.
   */
  readonly fetchUserscore?: boolean;
}

const NEW_RELEASES_PATH = '/game/';
const BROWSE_PATH = '/browse/game/all/all/all-time/new/';

export class MetacriticAdapter implements GameCatalogSource {
  readonly source: GameSource = 'metacritic';

  private readonly http: MetacriticHttpClient;
  private readonly logger: Logger;
  private readonly fetchUserscore: boolean;

  constructor(options: MetacriticAdapterOptions) {
    this.http = options.http;
    this.logger = options.logger ?? silentLogger;
    this.fetchUserscore = options.fetchUserscore ?? false;
  }

  async fetchListing(params: FetchListingParams): Promise<NormalizedListingPage> {
    const page = Math.max(1, params.page ?? 1);
    const path =
      params.section === 'new_releases'
        ? NEW_RELEASES_PATH
        : page === 1
          ? BROWSE_PATH
          : `${BROWSE_PATH}?page=${page}`;

    const startedAt = Date.now();
    const response = await this.http.get(path, params.signal);

    try {
      const result =
        params.section === 'new_releases'
          ? parseNewReleasesListing(response.body, { url: response.url })
          : parseBrowseListing(response.body, { url: response.url, page });

      this.logger.info('Листинг разобран', {
        source: this.source,
        operation: 'fetch_listing',
        section: params.section,
        page,
        url: response.url,
        status: response.status,
        durationMs: Date.now() - startedAt,
        parsedItems: result.items.length,
        skippedCards: result.skipped,
        parserResult: 'ok',
      });

      if (result.skipped > 0) {
        this.logger.warn('Часть карточек листинга не разобрана', {
          source: this.source,
          operation: 'fetch_listing',
          section: params.section,
          page,
          skippedCards: result.skipped,
          parsedItems: result.items.length,
        });
      }

      return result;
    } catch (error) {
      this.logError('fetch_listing', response.url, startedAt, error, {
        section: params.section,
        page,
        status: response.status,
      });
      throw error;
    }
  }

  async fetchGame(params: FetchGameParams): Promise<NormalizedGame> {
    const slug = params.sourceSlug.trim().toLowerCase();
    if (slug.length === 0) {
      throw new IngestionError('parse_error', 'Не указан slug игры', {});
    }

    const startedAt = Date.now();
    const response = await this.http.get(`/game/${slug}/`, params.signal);

    // Догрузка Userscore выключена по умолчанию: это отдельный HTTP-запрос
    // на игру. Исход фиксируется явно, чтобы отличить сбой от отсутствия.
    let userscoreOverall: number | null = null;
    let userscoreStatus: UserscoreStatus = 'disabled';

    if (this.fetchUserscore) {
      const outcome = await this.tryFetchUserscore(slug, params.signal);
      userscoreOverall = outcome.value;
      userscoreStatus = outcome.status;
    }

    try {
      const game = parseGameDetail(response.body, {
        sourceSlug: slug,
        url: response.url,
        userscoreOverall,
        userscoreStatus,
      });

      this.logger.info('Карточка игры разобрана', {
        source: this.source,
        operation: 'fetch_game',
        sourceSlug: slug,
        url: response.url,
        status: response.status,
        durationMs: Date.now() - startedAt,
        parsedPlatforms: game.platforms.length,
        developerStatus: game.developerStatus,
        parserResult: 'ok',
      });

      if (game.developerStatus === 'unknown') {
        // Отдельная запись: рост доли таких игр — признак смены разметки.
        this.logger.warn('Разработчик не определён', {
          source: this.source,
          operation: 'fetch_game',
          sourceSlug: slug,
          developerStatus: 'unknown',
        });
      }

      const degraded = game.platforms.filter(
        (platform) => platform.metascoreScope === 'overall_fallback',
      ).length;
      if (degraded > 0) {
        this.logger.warn('Оценка не связана с платформой достоверно', {
          source: this.source,
          operation: 'fetch_game',
          sourceSlug: slug,
          degradedPlatforms: degraded,
        });
      }

      return game;
    } catch (error) {
      this.logError('fetch_game', response.url, startedAt, error, {
        sourceSlug: slug,
        status: response.status,
      });
      throw error;
    }
  }

  /**
   * Общий Userscore — обогащение, а не обязательные данные: его отсутствие
   * не должно ронять разбор карточки игры.
   */
  private async tryFetchUserscore(
    slug: string,
    signal: AbortSignal | undefined,
  ): Promise<{ value: number | null; status: UserscoreStatus }> {
    try {
      const response = await this.http.get(`/game/${slug}/user-reviews/`, signal);
      const value = parseOverallUserscore(response.body);

      if (value === null) {
        // Страница получена, но значения на ней нет — это не сбой
        this.logger.info('Общий Userscore не опубликован', {
          source: this.source,
          operation: 'fetch_userscore',
          sourceSlug: slug,
          userscoreStatus: 'absent',
        });
        return { value: null, status: 'absent' };
      }

      this.logger.info('Общий Userscore получен', {
        source: this.source,
        operation: 'fetch_userscore',
        sourceSlug: slug,
        userscoreStatus: 'fetched',
      });
      return { value, status: 'fetched' };
    } catch (error) {
      // Отмена операции обязана дойти до вызывающего, а не выглядеть
      // как отсутствие Userscore.
      if (isIngestionError(error) && error.category === 'aborted') throw error;

      this.logger.warn('Не удалось получить общий Userscore', {
        source: this.source,
        operation: 'fetch_userscore',
        sourceSlug: slug,
        userscoreStatus: 'failed',
        errorCategory: isIngestionError(error) ? error.category : 'unknown',
      });
      return { value: null, status: 'failed' };
    }
  }

  private logError(
    operation: string,
    url: string,
    startedAt: number,
    error: unknown,
    extra: Record<string, unknown>,
  ): void {
    this.logger.error('Ошибка при получении данных источника', {
      source: this.source,
      operation,
      url,
      durationMs: Date.now() - startedAt,
      parserResult: 'error',
      errorCategory: isIngestionError(error) ? error.category : 'unknown',
      errorMessage: error instanceof Error ? error.message : String(error),
      ...extra,
    });
  }
}
