import type { Config } from '../../shared/config/index.js';
import type { DbPool } from '../../shared/db/pool.js';
import { PostgresUnitOfWork } from '../../shared/db/unit-of-work.js';
import type { Logger } from '../../shared/logging/logger.js';
import { PostgresGameRepository } from '../../modules/catalog/infrastructure/postgres-game-repository.js';
import { PostgresGamePlatformRepository } from '../../modules/catalog/infrastructure/postgres-game-platform-repository.js';
import { MetacriticAdapter } from '../../modules/ingestion/infrastructure/metacritic-adapter.js';
import { MetacriticHttpClient } from '../../modules/ingestion/infrastructure/metacritic-http-client.js';
import { LoggingIngestionEventSink } from '../../modules/ingestion/infrastructure/logging-event-sink.js';
import { IngestGameUseCase } from '../../modules/ingestion/application/ingest-game.js';
import { FindNextClaimableGamesUseCase } from '../../modules/ingestion/application/find-next-claimable-games.js';
import { RunDailyProcessingUseCase } from '../../modules/ingestion/application/run-daily-processing.js';
import { DailyProcessingScheduler } from '../../modules/ingestion/application/scheduler.js';
import { SystemProcessingDayProvider } from '../../modules/ingestion/domain/processing-day-provider.js';
import {
  PostgresClaimRepository,
  PostgresProcessingDayRepository,
} from '../../modules/ingestion/infrastructure/postgres-claim-repository.js';
import { PostgresRunRepository } from '../../modules/monitoring/infrastructure/postgres-run-repository.js';
import { PostgresRunLock } from '../../shared/db/run-lock.js';
import { MetacriticReviewSource } from '../../modules/reviews/infrastructure/metacritic-review-source.js';
import {
  hashContent,
  PostgresReviewRepository,
  PostgresReviewSnapshotRepository,
} from '../../modules/reviews/infrastructure/postgres-review-repository.js';
import { SyncReviewsUseCase } from '../../modules/reviews/application/sync-reviews.js';
import { AnalyzeReviewsUseCase } from '../../modules/analysis/application/analyze-reviews.js';
import { ProcessGamePipeline } from '../../modules/ingestion/application/process-game-pipeline.js';
import { OpenRouterLlmProvider } from '../../modules/analysis/infrastructure/openrouter-llm-provider.js';
import { PostgresReviewSummaryRepository } from '../../modules/analysis/infrastructure/postgres-summary-repository.js';
import { LoggingAnalysisEventSink } from '../../modules/analysis/infrastructure/logging-event-sink.js';

/**
 * Composition root слоя ingestion: связывает порты с реализациями.
 *
 * Это единственное место, где application-слой встречается с конкретными
 * адаптерами. Сам use case знает только про интерфейсы (ADR-0001).
 */

export interface IngestionComponents {
  readonly ingestGame: IngestGameUseCase;
  /** Синхронизация отзывов критиков; вызывается отдельно от игры. */
  readonly syncCriticReviews: SyncReviewsUseCase;
  readonly syncUserReviews: SyncReviewsUseCase;
  readonly runDailyProcessing: RunDailyProcessingUseCase;
  readonly scheduler: DailyProcessingScheduler;
  readonly httpClient: MetacriticHttpClient;
  /**
   * Анализ отзывов моделью. null, если LLM_ENABLED выключен либо ключ не
   * задан: конвейер обязан работать и без него (ADR-0013) — анализ лишь
   * обогащает данные, но не является условием их получения.
   */
  readonly analyzeReviews: AnalyzeReviewsUseCase | null;
}

export function buildIngestion(
  pool: DbPool,
  config: Config,
  logger: Logger,
): IngestionComponents {
  const httpClient = new MetacriticHttpClient({
    userAgent: config.metacriticUserAgent,
    requestsPerSecond: config.metacriticRateLimitRps,
    timeoutMs: config.httpTimeoutMs,
    logger,
  });

  const catalogSource = new MetacriticAdapter({
    http: httpClient,
    logger,
    // Догрузка Userscore управляется конфигурацией: это дополнительный
    // HTTP-запрос на игру, и решение принимается вне адаптера (ADR-0011).
    fetchUserscore: config.metacriticFetchUserscore,
  });

  const ingestGame = new IngestGameUseCase({
    catalogSource,
    games: new PostgresGameRepository(pool),
    platforms: new PostgresGamePlatformRepository(pool),
    unitOfWork: new PostgresUnitOfWork(pool),
    events: new LoggingIngestionEventSink(logger),
  });

  const dayProvider = new SystemProcessingDayProvider({
    timeZone: config.processingTimezone,
  });

  const claims = new PostgresClaimRepository(pool);
  const processingDays = new PostgresProcessingDayRepository(pool);
  const runs = new PostgresRunRepository(pool);
  const events = new LoggingIngestionEventSink(logger);

  const findCandidates = new FindNextClaimableGamesUseCase({
    catalogSource,
    claims,
    processingDays,
    maxPagesPerRun: config.maxPagesPerRun,
    maxEmptyPages: config.maxEmptyPages,
    leaseMinutes: config.workerLeaseMinutes,
  });

  // Источник отзывов использует ТОТ ЖЕ HTTP-клиент: общий ограничитель
  // частоты, повторы и обработка 403/429/5xx — второго стека нет.
  const reviewSource = new MetacriticReviewSource({ http: httpClient, logger });
  const reviewRepository = new PostgresReviewRepository(pool);
  const snapshotRepository = new PostgresReviewSnapshotRepository(pool);
  const unitOfWork = new PostgresUnitOfWork(pool);

  const syncCriticReviews = new SyncReviewsUseCase({
    source: reviewSource,
    reviews: reviewRepository,
    snapshots: snapshotRepository,
    unitOfWork,
    hash: hashContent,
    maxPages: config.reviewMaxPages,
    pageSize: config.reviewCriticPageSize,
    maxReviews: config.reviewMaxCritic,
  });

  const syncUserReviews = new SyncReviewsUseCase({
    source: reviewSource,
    reviews: reviewRepository,
    snapshots: snapshotRepository,
    unitOfWork,
    hash: hashContent,
    maxPages: config.reviewMaxPages,
    pageSize: config.reviewUserPageSize,
    maxReviews: config.reviewMaxUser,
  });

  const analyzeReviews = buildAnalysis(pool, config, logger, {
    reviews: reviewRepository,
    snapshots: snapshotRepository,
    unitOfWork,
  });

  // Конвейер одной игры: собирается из уже созданных use case.
  const pipeline = new ProcessGamePipeline({
    ingestGame,
    syncCriticReviews,
    syncUserReviews,
    analyzeReviews,
    events,
    now: () => dayProvider.now(),
    // Отзывы синхронизируются без разбивки по платформам, поэтому
    // резюме хранится под тем же ключом (см. миграцию 009).
    analysisPlatform: 'default',
  });

  const runDailyProcessing = new RunDailyProcessingUseCase({
    findCandidates,
    pipeline,
    claims,
    runs,
    runLock: new PostgresRunLock(pool),
    dayProvider,
    events,
    batchSize: config.batchSize,
    workerConcurrency: config.workerConcurrency,
    leaseMinutes: config.workerLeaseMinutes,
    heartbeatIntervalMs: config.workerHeartbeatIntervalSeconds * 1000,
    maxAttempts: config.maxAttempts,
  });

  const scheduler = new DailyProcessingScheduler({
    runDailyProcessing,
    intervalMs: config.schedulerIntervalMinutes * 60_000,
    timers: {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
    },
    events,
    onError: (error) => {
      logger.error('Ошибка планового запуска', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    },
  });

  return {
    ingestGame,
    syncCriticReviews,
    syncUserReviews,
    runDailyProcessing,
    scheduler,
    httpClient,
    analyzeReviews,
  };
}

/**
 * Сборка анализа отзывов.
 *
 * Возвращает null, если анализ выключен или ключ отсутствует: провайдер
 * создаётся только при наличии реального ключа из окружения. Ключ не
 * попадает ни в код, ни в логи — см. redactConfig.
 */
function buildAnalysis(
  pool: DbPool,
  config: Config,
  logger: Logger,
  deps: {
    reviews: PostgresReviewRepository;
    snapshots: PostgresReviewSnapshotRepository;
    unitOfWork: PostgresUnitOfWork;
  },
): AnalyzeReviewsUseCase | null {
  if (!config.llmEnabled) {
    logger.info('Анализ отзывов выключен', { operation: 'bootstrap', reason: 'disabled' });
    return null;
  }

  if (!config.llmApiKey) {
    // Явное предупреждение вместо тихого отключения: включённый анализ без
    // ключа — почти наверняка ошибка конфигурации, а не намерение.
    logger.warn('Анализ отзывов включён, но LLM_API_KEY не задан — анализ недоступен', {
      operation: 'bootstrap',
      reason: 'missing_api_key',
    });
    return null;
  }

  const provider = new OpenRouterLlmProvider({
    apiKey: config.llmApiKey,
    model: config.llmModel,
    timeoutMs: config.llmTimeoutMs,
    maxOutputTokens: config.llmMaxOutputTokens,
    logger,
  });

  return new AnalyzeReviewsUseCase({
    provider,
    reviews: deps.reviews,
    snapshots: deps.snapshots,
    summaries: new PostgresReviewSummaryRepository(pool),
    unitOfWork: deps.unitOfWork,
    events: new LoggingAnalysisEventSink(logger),
    hash: hashContent,
    limits: {
      maxReviews: config.llmMaxReviews,
      maxReviewChars: config.llmMaxReviewChars,
      maxInputChars: config.llmMaxInputTokens * 4,
    },
    promptVersion: config.llmPromptVersion,
    samplingVersion: config.llmSamplingVersion,
    minReviews: config.llmMinReviews,
    retryCount: config.llmRetryCount,
    maxOutputTokens: config.llmMaxOutputTokens,
  });
}
