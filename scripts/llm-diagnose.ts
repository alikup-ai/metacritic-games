/**
 * Диагностика отклонённых ответов модели.
 *
 * Обращается к OpenRouter тем же путём, что и рабочий адаптер (та же схема,
 * тот же промпт, та же выборка), но НЕ проверяет ответ схемой: цель —
 * измерить фактические длины полей и понять, насколько превышен предел.
 *
 * Ничего не сохраняет в базу и не меняет production-код.
 *
 * Запуск: node --import tsx scripts/llm-diagnose.ts <gameId> <critic|user>
 */

import { z } from 'zod/v4';
import { loadConfig } from '../src/shared/config/index.js';
import { createPool } from '../src/shared/db/pool.js';
import { PostgresReviewRepository } from '../src/modules/reviews/infrastructure/postgres-review-repository.js';
import { PostgresGameRepository } from '../src/modules/catalog/infrastructure/postgres-game-repository.js';
import { selectReviewsForAnalysis } from '../src/modules/analysis/application/select-reviews.js';
import { analysisOutputSchema } from '../src/modules/analysis/application/validate-output.js';
import {
  buildSystemPrompt,
  buildUserPrompt,
} from '../src/modules/analysis/infrastructure/prompts.js';
import type { ReviewKind } from '../src/modules/reviews/domain/review.js';

async function main(): Promise<void> {
  const gameId = process.argv[2];
  const kind = (process.argv[3] ?? 'user') as ReviewKind;
  if (!gameId) {
    console.error('Укажите gameId и вид отзывов');
    process.exit(1);
  }

  const config = loadConfig();
  if (!config.llmApiKey) {
    console.error('LLM_API_KEY не задан');
    process.exit(1);
  }

  const pool = createPool(config);
  const game = await new PostgresGameRepository(pool).findById(gameId);
  if (!game) {
    console.error('Игра не найдена');
    await pool.end();
    process.exit(1);
  }

  const stored = await new PostgresReviewRepository(pool).findByGame({
    gameId,
    kind,
    platformSlug: 'default',
  });

  const selection = selectReviewsForAnalysis(stored, kind, {
    maxReviews: config.llmMaxReviews,
    maxReviewChars: config.llmMaxReviewChars,
    maxInputChars: config.llmMaxInputTokens * 4,
  });

  const request = {
    kind,
    gameTitle: game.title,
    platformSlug: 'default',
    reviews: selection.reviews,
    analyzedCount: selection.analyzedCount,
    totalAvailable: stored.length,
    promptVersion: config.llmPromptVersion,
    samplingVersion: config.llmSamplingVersion,
    maxOutputTokens: config.llmMaxOutputTokens,
  };

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.llmApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.llmModel,
      max_tokens: config.llmMaxOutputTokens,
      messages: [
        { role: 'system', content: buildSystemPrompt(kind) },
        { role: 'user', content: buildUserPrompt(request) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'review_analysis',
          strict: true,
          schema: z.toJSONSchema(analysisOutputSchema, { target: 'draft-7' }),
        },
      },
    }),
  });

  const payload = (await response.json()) as {
    choices?: { finish_reason?: string; message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const choice = payload.choices?.[0];
  const content = choice?.message?.content ?? '';

  console.log(`Игра: ${game.title} [${kind}]`);
  console.log(`Отзывов отобрано: ${selection.analyzedCount} из ${stored.length}`);
  console.log(`finish_reason: ${choice?.finish_reason ?? '?'}`);
  console.log(
    `токены: вход ${payload.usage?.prompt_tokens ?? '?'}, выход ${payload.usage?.completion_tokens ?? '?'}`,
  );

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    console.log(`ОТВЕТ НЕ JSON, длина ${content.length} символов`);
    await pool.end();
    return;
  }

  const summary = String(parsed.summary ?? '');
  const liked = (parsed.liked ?? []) as { text: string; evidenceRefs: string[] }[];
  const disliked = (parsed.disliked ?? []) as { text: string; evidenceRefs: string[] }[];
  const themes = (parsed.themes ?? []) as {
    name: string;
    description: string;
    evidenceRefs: string[];
  }[];

  const maxRefs = (items: { evidenceRefs: string[] }[]): number =>
    items.reduce((m, i) => Math.max(m, i.evidenceRefs?.length ?? 0), 0);

  console.log('--- ФАКТИЧЕСКИЕ РАЗМЕРЫ ---');
  console.log(`summary: ${summary.length} символов (предел 2500)`);
  console.log(`liked: ${liked.length} пунктов (предел 20), макс. text ${liked.reduce((m, i) => Math.max(m, i.text?.length ?? 0), 0)} (предел 300), макс. refs ${maxRefs(liked)} (предел 16)`);
  console.log(`disliked: ${disliked.length} пунктов, макс. text ${disliked.reduce((m, i) => Math.max(m, i.text?.length ?? 0), 0)}, макс. refs ${maxRefs(disliked)}`);
  console.log(`themes: ${themes.length} тем (предел 20), макс. description ${themes.reduce((m, i) => Math.max(m, i.description?.length ?? 0), 0)} (предел 400), макс. refs ${maxRefs(themes)}`);

  const check = analysisOutputSchema.safeParse(parsed);
  console.log(`--- ПРОВЕРКА СХЕМОЙ: ${check.success ? 'пройдена' : 'ОТКЛОНЕНО'} ---`);
  if (!check.success) {
    for (const issue of check.error.issues) {
      console.log(`  ${issue.path.join('.') || '(root)'}: ${issue.code}`);
    }
  }

  await pool.end();
}

main().catch((error: unknown) => {
  console.error('Сбой:', error instanceof Error ? error.message : error);
  process.exit(1);
});
