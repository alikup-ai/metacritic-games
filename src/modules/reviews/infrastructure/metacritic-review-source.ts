import { IngestionError } from '../../ingestion/domain/ingestion-errors.js';
import type { MetacriticHttpClient } from '../../ingestion/infrastructure/metacritic-http-client.js';
import { silentLogger, type Logger } from '../../../shared/logging/logger.js';
import type { NormalizedReviewPage } from '../domain/review.js';
import type { FetchReviewPageParams, ReviewSource } from '../domain/review-ports.js';
import { parseReviewPage } from './parsers/review-parser.js';

/**
 * Источник отзывов Metacritic.
 *
 * Использует УЖЕ СУЩЕСТВУЮЩИЙ HTTP-клиент со всей его политикой: общий
 * ограничитель частоты, повторы с backoff, обработка 403/429/5xx,
 * структурное логирование без секретов. Второй HTTP-стек не создаётся.
 *
 * Endpoint обнаружен исследованием (docs/METACRITIC_REVIEWS_RESEARCH.md):
 *   /reviews/metacritic/{critic|user}/games/{slug}[/platform/{p}]/web
 *
 * Платформа задаётся СЕГМЕНТОМ ПУТИ; параметры ?platform= источником
 * игнорируются — проверено.
 */

export interface MetacriticReviewSourceOptions {
  readonly http: MetacriticHttpClient;
  readonly logger?: Logger;
  /** Базовый хост API отзывов; отличается от каталожного. */
  readonly apiBaseUrl?: string;
}

const DEFAULT_API_BASE = 'https://backend.metacritic.com/reviews/metacritic';

/** Критический endpoint игнорирует limit и всегда отдаёт 10 записей. */
export const CRITIC_PAGE_SIZE = 10;
/** Пользовательский endpoint принимает до 200. */
export const USER_MAX_PAGE_SIZE = 200;

export class MetacriticReviewSource implements ReviewSource {
  private readonly http: MetacriticHttpClient;
  private readonly logger: Logger;
  private readonly apiBaseUrl: string;

  constructor(options: MetacriticReviewSourceOptions) {
    this.http = options.http;
    this.logger = options.logger ?? silentLogger;
    this.apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/$/, '');
  }

  buildUrl(params: FetchReviewPageParams): string {
    const slug = params.sourceSlug.trim().toLowerCase();
    const platformSegment = params.platform ? `/platform/${params.platform}` : '';

    const query = new URLSearchParams({
      offset: String(params.offset),
      limit: String(params.limit),
      filterBySentiment: 'all',
      sort: 'date',
      componentName: `${params.kind}-reviews`,
      componentType: 'ReviewList',
    });

    return `${this.apiBaseUrl}/${params.kind}/games/${slug}${platformSegment}/web?${query.toString()}`;
  }

  async fetchReviewPage(params: FetchReviewPageParams): Promise<NormalizedReviewPage> {
    const slug = params.sourceSlug.trim().toLowerCase();
    if (slug.length === 0) {
      throw new IngestionError('parse_error', 'Не указан slug игры', {});
    }

    const url = this.buildUrl({ ...params, sourceSlug: slug });
    const startedAt = Date.now();

    const response = await this.http.get(url, params.signal);

    let payload: unknown;
    try {
      payload = JSON.parse(response.body);
    } catch (error) {
      // Ответ получен, но это не JSON: структура источника изменилась.
      throw new IngestionError(
        'parse_error',
        'Ответ источника отзывов не является корректным JSON',
        { url, status: response.status },
        { cause: error },
      );
    }

    const page = parseReviewPage(params.kind, payload, {
      url,
      // Платформа берётся из ПАРАМЕТРА ЗАПРОСА, а не из поля внутри записи:
      // при обходе без платформы источник проставляет основную платформу
      // игры, что не соответствует реальной платформе рецензии.
      platformSlug: params.platform ?? 'default',
    });

    this.logger.info('Страница отзывов разобрана', {
      source: 'metacritic',
      operation: 'fetch_reviews',
      kind: params.kind,
      sourceSlug: slug,
      platform: params.platform ?? 'default',
      offset: params.offset,
      status: response.status,
      durationMs: Date.now() - startedAt,
      parsedReviews: page.reviews.length,
      malformed: page.malformed,
      totalAvailable: page.totalAvailable,
      // Тексты отзывов в лог не попадают — только счётчики
    });

    if (page.malformed > 0) {
      this.logger.warn('Часть записей отзывов не разобрана', {
        source: 'metacritic',
        operation: 'fetch_reviews',
        kind: params.kind,
        sourceSlug: slug,
        malformed: page.malformed,
        parsedReviews: page.reviews.length,
      });
    }

    return page;
  }
}
