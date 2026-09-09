/**
 * Проверка разбора отзывов на реальном провайдере.
 *
 * Использует ТОТ ЖЕ путь, что и рабочий конвейер: AnalyzeReviewsUseCase с
 * OpenRouterLlmProvider, собранные так же, как в composition root.
 * Отдельной production-ветки ради проверки не создаётся.
 *
 * Запуск:
 *   node --import tsx scripts/llm-smoke.ts <gameId> [critic|user]
 *
 * Ключ берётся из .env через loadConfig и нигде не выводится.
 */

import { loadConfig } from '../src/shared/config/index.js';
import { createPool } from '../src/shared/db/pool.js';
import { PostgresUnitOfWork } from '../src/shared/db/unit-of-work.js';
import { StructuredLogger } from '../src/shared/logging/logger.js';
import {
  hashContent,
  PostgresReviewRepository,
  PostgresReviewSnapshotRepository,
} from '../src/modules/reviews/infrastructure/postgres-review-repository.js';
import { PostgresReviewSummaryRepository } from '../src/modules/analysis/infrastructure/postgres-summary-repository.js';
import { PostgresGameRepository } from '../src/modules/catalog/infrastructure/postgres-game-repository.js';
import { AnalyzeReviewsUseCase } from '../src/modules/analysis/application/analyze-reviews.js';
import { OpenRouterLlmProvider } from '../src/modules/analysis/infrastructure/openrouter-llm-provider.js';
import { RecordingAnalysisEventSink } from '../src/modules/analysis/domain/analysis-events.js';
import type { ReviewKind } from '../src/modules/reviews/domain/review.js';

async function main(): Promise<void> {
  const gameId = process.argv[2];
  const kind = (process.argv[3] ?? 'user') as ReviewKind;

  if (!gameId) {
    console.error('Укажите gameId: node --import tsx scripts/llm-smoke.ts <gameId> [critic|user]');
    process.exit(1);
  }

  const config = loadConfig();

  if (!config.llmEnabled) {
    console.error('LLM_ENABLED=false — разбор выключен конфигурацией');
    process.exit(1);
  }
  if (!config.llmApiKey) {
    console.error('LLM_API_KEY не задан в .env');
    process.exit(1);
  }

  const pool = createPool(config);
  const logger = new StructuredLogger({ level: 'warn' });
  const events = new RecordingAnalysisEventSink();

  const provider = new OpenRouterLlmProvider({
    apiKey: config.llmApiKey,
    model: config.llmModel,
    timeoutMs: config.llmTimeoutMs,
    maxOutputTokens: config.llmMaxOutputTokens,
    logger,
  });

  const useCase = new AnalyzeReviewsUseCase({
    provider,
    reviews: new PostgresReviewRepository(pool),
    snapshots: new PostgresReviewSnapshotRepository(pool),
    summaries: new PostgresReviewSummaryRepository(pool),
    unitOfWork: new PostgresUnitOfWork(pool),
    events,
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

  const game = await new PostgresGameRepository(pool).findById(gameId);
  if (!game) {
    console.error('Игра не найдена');
    await pool.end();
    process.exit(1);
  }

  console.log(`Игра: ${game.title}`);
  console.log(`Вид отзывов: ${kind}`);
  console.log(`Модель: ${config.llmModel}`);
  console.log('---');

  const startedAt = Date.now();
  const result = await useCase.execute({
    gameId,
    gameTitle: game.title,
    kind,
    platformSlug: 'default',
  });

  console.log(`Статус: ${result.status}`);
  console.log(`Проанализировано: ${result.analyzedCount}`);
  console.log(`Покрытие: ${result.coverage}`);
  console.log(`Попыток: ${result.attempts}`);
  console.log(`Длительность: ${Date.now() - startedAt} мс`);
  console.log(`Входной хеш: ${result.inputHash?.slice(0, 16) ?? 'нет'}…`);

  const failed = events.ofType('llm_analysis_failed');
  if (failed.length > 0) {
    console.log(`ОШИБКА: ${failed[0]!.errorCategory} — ${failed[0]!.errorMessage}`);
  }

  await pool.end();
}

main().catch((error: unknown) => {
  // Сообщение провайдера не содержит ключа (проверено тестами адаптера)
  console.error('Сбой:', error instanceof Error ? error.message : error);
  process.exit(1);
});
