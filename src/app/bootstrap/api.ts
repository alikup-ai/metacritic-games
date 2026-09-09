import type { Config } from '../../shared/config/index.js';
import type { DbPool } from '../../shared/db/pool.js';
import type { Logger } from '../../shared/logging/logger.js';
import { PostgresGameRepository } from '../../modules/catalog/infrastructure/postgres-game-repository.js';
import { PostgresGamePlatformRepository } from '../../modules/catalog/infrastructure/postgres-game-platform-repository.js';
import { PostgresReviewRepository } from '../../modules/reviews/infrastructure/postgres-review-repository.js';
import { PostgresReviewSummaryRepository } from '../../modules/analysis/infrastructure/postgres-summary-repository.js';
import { PostgresRunRepository } from '../../modules/monitoring/infrastructure/postgres-run-repository.js';
import { PostgresClaimRepository } from '../../modules/ingestion/infrastructure/postgres-claim-repository.js';
import { FindSimilarGamesUseCase } from '../../modules/similarity/application/find-similar-games.js';
import { PostgresVideoInsightRepository } from '../../modules/video/infrastructure/postgres-video-repository.js';
import { EnrichGameVideoUseCase } from '../../modules/video/application/enrich-game-video.js';
import { YouTubeSearchAdapter } from '../../modules/video/infrastructure/youtube-search.js';
import { YouTubeTranscriptAdapter } from '../../modules/video/infrastructure/youtube-transcript.js';
import { SupadataTranscriptAdapter } from '../../modules/video/infrastructure/supadata-transcript.js';
import { FallbackTranscriptAdapter } from '../../modules/video/infrastructure/fallback-transcript.js';
import type { TranscriptPort } from '../../modules/video/domain/video-ports.js';
import {
  OpenRouterVideoAnalysis,
  VIDEO_PROMPT_VERSION,
} from '../../modules/video/infrastructure/video-analysis-openrouter.js';
import { hashContent } from '../../modules/reviews/infrastructure/postgres-review-repository.js';
import type { RunDailyProcessingUseCase } from '../../modules/ingestion/application/run-daily-processing.js';
import { Router } from '../../api/server.js';
import { RateLimiter } from '../../api/http/rate-limit.js';
import {
  createGetAnalysisHandler,
  createGetGameHandler,
  createListGamesHandler,
  createListPlatformsHandler,
  createListReviewsHandler,
  createGetVideoHandler,
  createEnrichVideoHandler,
  type CatalogDeps,
} from '../../api/routes/catalog-routes.js';
import {
  createGetRunHandler,
  createHealthHandler,
  createListRunsHandler,
  createTriggerRunHandler,
  createWorkerStatusHandler,
  type MonitoringDeps,
} from '../../api/routes/monitoring-routes.js';

/**
 * Composition root слоя API.
 *
 * Единственное место, где маршруты встречаются с конкретными адаптерами
 * PostgreSQL. Сами маршруты знают только про порты (ADR-0001).
 */

export interface BuildApiOptions {
  readonly pool: DbPool;
  readonly config: Config;
  /** Используется сервером при обработке запросов. */
  readonly logger: Logger;
  /**
   * Обработка суток. Передаётся снаружи, поскольку собирается вместе с
   * остальным конвейером; null отключает ручной запуск.
   */
  readonly runDailyProcessing: RunDailyProcessingUseCase | null;
}

export function buildApiRouter(options: BuildApiOptions): Router {
  const { pool, config, logger } = options;

  const catalog: CatalogDeps = {
    games: new PostgresGameRepository(pool),
    platforms: new PostgresGamePlatformRepository(pool),
    reviews: new PostgresReviewRepository(pool),
    summaries: new PostgresReviewSummaryRepository(pool),
    similar: new FindSimilarGamesUseCase({
      games: new PostgresGameRepository(pool),
      // Каталог невелик; предел защищает запрос при его росте
      candidateLimit: 500,
    }),
    // Чтение обогащения доступно всегда: сохранённый результат можно
    // показать, даже когда сама функция выключена
    videoInsights: new PostgresVideoInsightRepository(pool),
    enrichVideo: buildVideoEnrichment(pool, config, logger),
    pageDefaults: {
      defaultSize: config.apiDefaultPageSize,
      maxSize: config.apiMaxPageSize,
    },
  };

  const monitoring: MonitoringDeps = {
    runs: new PostgresRunRepository(pool),
    claims: new PostgresClaimRepository(pool),
    runDailyProcessing: options.runDailyProcessing,
    // Токен приходит из окружения; в логи не попадает (redactConfig).
    adminToken: config.adminToken,
    rateLimiter: new RateLimiter({
      windowMs: config.apiRateLimitWindowMs,
      max: config.apiRateLimitMax,
    }),
    runListDefaults: { defaultLimit: 20, maxLimit: 100 },
  };

  return new Router()
    .get('/api/health', createHealthHandler({ ping: async () => void (await pool.query('SELECT 1')) }))
    .get('/api/games', createListGamesHandler(catalog))
    .get('/api/games/:id', createGetGameHandler(catalog))
    .get('/api/games/:id/analysis', createGetAnalysisHandler(catalog))
    .get('/api/games/:id/reviews', createListReviewsHandler(catalog))
    .get('/api/games/:id/video', createGetVideoHandler(catalog))
    .post('/api/games/:id/video', createEnrichVideoHandler(catalog))
    .get('/api/platforms', createListPlatformsHandler(catalog))
    .post('/api/runs', createTriggerRunHandler(monitoring))
    .get('/api/runs', createListRunsHandler(monitoring))
    .get('/api/runs/:id', createGetRunHandler(monitoring))
    .get('/api/monitoring/workers', createWorkerStatusHandler(monitoring));
}

/**
 * Сборка обогащения видео.
 *
 * Возвращает null, если функция выключена либо нет ключа YouTube:
 * основной конвейер от этого не страдает (ADR-0005).
 */
function buildVideoEnrichment(
  pool: DbPool,
  config: Config,
  logger: Logger,
): EnrichGameVideoUseCase | null {
  if (!config.youtubeEnabled) {
    logger.info('Обогащение видео выключено', {
      operation: 'bootstrap',
      reason: 'disabled',
    });
    return null;
  }

  if (!config.youtubeApiKey) {
    logger.warn('YOUTUBE_ENABLED=true, но YOUTUBE_API_KEY не задан', {
      operation: 'bootstrap',
      reason: 'missing_api_key',
    });
    return null;
  }

  // Разбор доступен только при настроенном шлюзе модели; без него
  // сохранится сам ролик, но без выводов
  const analysis =
    config.llmEnabled && config.llmApiKey
      ? new OpenRouterVideoAnalysis({
          apiKey: config.llmApiKey,
          model: config.llmModel,
          timeoutMs: config.llmTimeoutMs,
          logger,
        })
      : null;

  const search = new YouTubeSearchAdapter({
    apiKey: config.youtubeApiKey,
    timeoutMs: config.youtubeTimeoutMs,
    logger,
  });

  // Цепочка поставщиков расшифровки: сначала бесплатные субтитры
  // YouTube, затем платный внешний сервис. Слой application видит один
  // поставщик и о цепочке не знает.
  const providers: { name: string; provider: TranscriptPort }[] = [
    {
      name: 'youtube_timedtext',
      provider: new YouTubeTranscriptAdapter({
        timeoutMs: config.youtubeTimeoutMs,
        logger,
        // Языки берутся из фактических дорожек, а не угадываются
        captionLanguages: (params) => search.listCaptionLanguages(params),
        fallbackLanguage: config.transcriptFallbackLanguage ?? null,
      }),
    },
  ];

  if (config.supadataApiKey) {
    providers.push({
      name: 'supadata',
      provider: new SupadataTranscriptAdapter({
        apiKey: config.supadataApiKey,
        timeoutMs: config.supadataTimeoutMs,
        logger,
        fallbackLanguage: config.transcriptFallbackLanguage ?? null,
      }),
    });
  } else {
    // Отсутствие ключа не является ошибкой: остаётся один timedtext
    logger.info('Внешний поставщик расшифровок не настроен', {
      operation: 'bootstrap',
      reason: 'missing_supadata_key',
    });
  }

  return new EnrichGameVideoUseCase({
    search,
    transcripts: new FallbackTranscriptAdapter({ providers, logger }),
    analysis,
    insights: new PostgresVideoInsightRepository(pool),
    hash: hashContent,
    limits: {
      minDurationSeconds: config.youtubeMinDurationSeconds,
      maxDurationSeconds: config.youtubeMaxDurationSeconds,
    },
    maxSearchResults: config.youtubeMaxResults,
    promptVersion: VIDEO_PROMPT_VERSION,
    maxOutputTokens: config.llmMaxOutputTokens,
    maxTranscriptChars: config.youtubeMaxTranscriptChars,
  });
}
