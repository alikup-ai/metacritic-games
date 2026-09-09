import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AnalyzeReviewsUseCase } from '../../src/modules/analysis/application/analyze-reviews.js';
import { FakeLlmProvider } from '../../src/modules/analysis/infrastructure/fake-llm-provider.js';
import { RecordingAnalysisEventSink } from '../../src/modules/analysis/domain/analysis-events.js';
import { LlmError } from '../../src/modules/analysis/domain/llm-provider.js';
import type {
  ReviewSummary,
  ReviewSummaryRepository,
} from '../../src/modules/analysis/domain/summary.js';
import type { ReviewKind, StoredReview } from '../../src/modules/reviews/domain/review.js';

/**
 * Тесты варианта использования. Ни сети, ни БД: провайдер поддельный,
 * хранилища в памяти. Реальный LLM API не вызывается.
 */

const hash = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');

function review(id: string, score: number, quote?: string): StoredReview {
  return {
    id: `db-${id}`,
    gameId: 'game-1',
    identity: { kind: 'user', externalId: id },
    platformSlug: 'pc',
    score,
    quote: quote ?? `Отзыв номер ${id} с достаточным объёмом текста`,
    author: 'автор',
    reviewUrl: null,
    reviewDate: '2026-01-01',
    sourceVersion: null,
    spoiler: false,
    contentHash: `hash-${id}`,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
  };
}

/** Хранилище резюме в памяти с тем же ключом, что и уникальный индекс. */
class MemorySummaryRepository implements ReviewSummaryRepository {
  readonly rows = new Map<string, ReviewSummary>();

  private key(p: { gameId: string; kind: ReviewKind; platformSlug: string }): string {
    return `${p.gameId}|${p.kind}|${p.platformSlug}`;
  }

  async find(params: {
    gameId: string;
    kind: ReviewKind;
    platformSlug: string;
  }): Promise<ReviewSummary | null> {
    return this.rows.get(this.key(params)) ?? null;
  }

  async findByGame(gameId: string): Promise<readonly ReviewSummary[]> {
    return [...this.rows.values()].filter((row) => row.gameId === gameId);
  }

  async save(summary: ReviewSummary): Promise<void> {
    this.rows.set(this.key(summary), summary);
  }
}

function makeDeps(overrides: {
  reviews?: StoredReview[];
  provider?: FakeLlmProvider;
  summaries?: MemorySummaryRepository;
  events?: RecordingAnalysisEventSink;
  minReviews?: number;
  retryCount?: number;
  txFails?: boolean;
}) {
  const stored = overrides.reviews ?? [review('u1', 9), review('u2', 3), review('u3', 7)];
  const summaries = overrides.summaries ?? new MemorySummaryRepository();
  const provider = overrides.provider ?? new FakeLlmProvider();
  const events = overrides.events ?? new RecordingAnalysisEventSink();

  const useCase = new AnalyzeReviewsUseCase({
    provider,
    reviews: {
      findByGame: async () => stored,
    } as never,
    snapshots: {
      find: async () => ({
        fingerprint: 'fp-1',
        totalAvailable: stored.length,
        completeness: 'complete',
      }),
    } as never,
    summaries,
    unitOfWork: {
      withTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
        if (overrides.txFails) throw new Error('сбой транзакции');
        return fn({});
      },
    } as never,
    events,
    hash,
    limits: { maxReviews: 10, maxReviewChars: 500, maxInputChars: 50_000 },
    promptVersion: 'v1',
    samplingVersion: 'v1',
    minReviews: overrides.minReviews ?? 3,
    retryCount: overrides.retryCount ?? 2,
    maxOutputTokens: 1500,
    sleep: async () => undefined,
    now: () => new Date('2026-01-01T00:00:00Z'),
  });

  return { useCase, summaries, provider, events, stored };
}

const params = {
  gameId: 'game-1',
  gameTitle: 'Тестовая игра',
  kind: 'user' as ReviewKind,
  platformSlug: 'pc',
};

describe('Успешный анализ', () => {
  it('сохраняет резюме и публикует событие завершения', async () => {
    const { useCase, summaries, events } = makeDeps({});
    const result = await useCase.execute(params);

    expect(result.status).toBe('ok');
    expect(result.inputHash).toBeTruthy();

    const saved = await summaries.find(params);
    expect(saved?.status).toBe('ok');
    expect(saved?.summary).toContain('Тестовая игра');
    expect(saved?.liked).toHaveLength(1);
    // Ссылки указывают на реально переданные отзывы
    expect(saved?.liked[0]?.evidenceRefs.every((ref) => /^r\d+$/.test(ref))).toBe(true);
    expect(saved?.confidence).toBe('low');

    expect(events.ofType('llm_analysis_started')).toHaveLength(1);
    expect(events.ofType('llm_analysis_completed')).toHaveLength(1);
  });

  it('счётчики берутся из наших данных, а не из ответа модели', async () => {
    const { useCase, summaries } = makeDeps({});
    await useCase.execute(params);

    const saved = await summaries.find(params);
    expect(saved?.analyzedCount).toBe(3);
    expect(saved?.totalAvailable).toBe(3);
    expect(saved?.snapshotCompleteness).toBe('complete');
    expect(saved?.coverage).toBe('all_reviews');
  });

  it('расход токенов сохраняется', async () => {
    const provider = new FakeLlmProvider({
      usage: { inputTokens: 1234, outputTokens: 567 },
    });
    const { useCase, summaries } = makeDeps({ provider });
    await useCase.execute(params);

    const saved = await summaries.find(params);
    expect(saved?.tokensIn).toBe(1234);
    expect(saved?.tokensOut).toBe(567);
  });

  it('отсутствие расхода токенов даёт null, а не выдуманное число', async () => {
    const provider = new FakeLlmProvider({
      usage: { inputTokens: null, outputTokens: null },
    });
    const { useCase, summaries } = makeDeps({ provider });
    await useCase.execute(params);

    const saved = await summaries.find(params);
    expect(saved?.tokensIn).toBeNull();
    expect(saved?.tokensOut).toBeNull();
  });
});

describe('Идемпотентность', () => {
  it('повторный запуск с тем же входом не вызывает модель', async () => {
    const { useCase, provider, events } = makeDeps({});

    await useCase.execute(params);
    expect(provider.requests).toHaveLength(1);

    const second = await useCase.execute(params);

    expect(provider.requests).toHaveLength(1);
    expect(second.status).toBe('skipped');
    expect(events.ofType('llm_analysis_skipped')[0]?.reason).toBe('input_unchanged');
  });

  it('изменение отзыва запускает новый анализ', async () => {
    const summaries = new MemorySummaryRepository();
    const provider = new FakeLlmProvider();

    const first = makeDeps({ summaries, provider });
    await first.useCase.execute(params);

    const changed = makeDeps({
      summaries,
      provider,
      reviews: [review('u1', 9, 'ИЗМЕНЁННЫЙ текст отзыва'), review('u2', 3), review('u3', 7)],
    });
    const result = await changed.useCase.execute(params);

    expect(provider.requests).toHaveLength(2);
    expect(result.status).toBe('ok');
  });

  it('неуспешное резюме не кешируется — хеш не сохраняется', async () => {
    const provider = new FakeLlmProvider({ failWith: new LlmError('client_error', 'отказ') });
    const { useCase, summaries } = makeDeps({ provider });

    const result = await useCase.execute(params);

    expect(result.status).toBe('failed');
    const saved = await summaries.find(params);
    expect(saved?.status).toBe('failed');
    expect(saved?.inputHash).toBeNull();
  });

  it('после неудачи следующий запуск снова обращается к модели', async () => {
    const summaries = new MemorySummaryRepository();

    const failing = makeDeps({
      summaries,
      provider: new FakeLlmProvider({ failWith: new LlmError('client_error', 'отказ') }),
    });
    await failing.useCase.execute(params);

    const retrying = makeDeps({
      summaries,
      provider: new FakeLlmProvider(),
    });
    const result = await retrying.useCase.execute(params);

    expect(result.status).toBe('ok');
    expect(retrying.provider.requests).toHaveLength(1);
  });
});

describe('Недостаточно отзывов', () => {
  it('модель не вызывается, статус фиксируется', async () => {
    const { useCase, provider, summaries, events } = makeDeps({
      reviews: [review('u1', 9)],
      minReviews: 3,
    });

    const result = await useCase.execute(params);

    expect(result.status).toBe('insufficient_reviews');
    expect(provider.requests).toHaveLength(0);
    expect((await summaries.find(params))?.status).toBe('insufficient_reviews');
    expect(events.ofType('llm_analysis_skipped')[0]?.reason).toBe('insufficient_reviews');
  });
});

describe('Обработка сбоев', () => {
  it('транзиентная ошибка повторяется и может завершиться успехом', async () => {
    // failTimes бросает транзиентную ошибку заданное число раз, затем успех
    const provider = new FakeLlmProvider({ failTimes: 2 });
    const { useCase } = makeDeps({ provider, retryCount: 2 });

    const result = await useCase.execute(params);

    expect(result.status).toBe('ok');
    expect(result.attempts).toBe(3);
  });

  it('постоянная 4xx не повторяется', async () => {
    const provider = new FakeLlmProvider({ failWith: new LlmError('client_error', 'отказ') });
    const { useCase } = makeDeps({ provider, retryCount: 3 });

    const result = await useCase.execute(params);

    expect(result.status).toBe('failed');
    expect(provider.requests).toHaveLength(1);
  });

  it('отмена не повторяется', async () => {
    const provider = new FakeLlmProvider({ failWith: new LlmError('aborted', 'отменено') });
    const { useCase } = makeDeps({ provider, retryCount: 3 });

    await useCase.execute(params);
    expect(provider.requests).toHaveLength(1);
  });

  it('превышение лимита токенов не повторяется', async () => {
    const provider = new FakeLlmProvider({ failWith: new LlmError('token_limit', 'обрезано') });
    const { useCase } = makeDeps({ provider, retryCount: 3 });

    await useCase.execute(params);
    expect(provider.requests).toHaveLength(1);
  });

  it('ответ со ссылкой на несуществующий отзыв повторяется ровно один раз', async () => {
    // Валидный JSON, но evidenceRefs указывает на отзыв, которого не было
    const provider = new FakeLlmProvider({
      rawResponse: JSON.stringify({
        summary: 'Резюме достаточной длины для прохождения проверки схемы.',
        liked: [{ text: 'Нечто', evidenceRefs: ['r999'] }],
        disliked: [],
        themes: [],
        confidence: 'low',
      }),
    });
    const { useCase } = makeDeps({ provider, retryCount: 5 });

    const result = await useCase.execute(params);

    expect(result.status).toBe('failed');
    // Один исходный вызов плюс единственный повтор
    expect(provider.requests).toHaveLength(2);
  });

  it('ошибка ссылок на свидетельства фиксируется своей категорией', async () => {
    const provider = new FakeLlmProvider({
      failWith: new LlmError('evidence_invalid', 'ссылка на отсутствующий отзыв'),
    });
    const { useCase, summaries, events } = makeDeps({ provider });

    await useCase.execute(params);

    expect((await summaries.find(params))?.errorCategory).toBe('evidence_invalid');
    expect(events.ofType('llm_analysis_failed')).toHaveLength(1);
  });

  it('исходные отзывы остаются нетронутыми при сбое', async () => {
    const stored = [review('u1', 9), review('u2', 3), review('u3', 7)];
    const before = JSON.stringify(stored);

    const provider = new FakeLlmProvider({ failWith: new LlmError('server_error', 'сбой') });
    const { useCase } = makeDeps({ provider, reviews: stored, retryCount: 0 });

    await useCase.execute(params);

    expect(JSON.stringify(stored)).toBe(before);
  });

  it('сбой транзакции не оставляет успешного резюме', async () => {
    const { useCase, summaries } = makeDeps({ txFails: true });

    const result = await useCase.execute(params);

    expect(result.status).toBe('failed');
    // Запись о неудаче тоже идёт через транзакцию — она также не сохраняется
    expect(summaries.rows.size).toBe(0);
  });
});

describe('Изоляция по типу и платформе', () => {
  let summaries: MemorySummaryRepository;

  beforeEach(() => {
    summaries = new MemorySummaryRepository();
  });

  it('критики и пользователи хранятся раздельно', async () => {
    const provider = new FakeLlmProvider();

    await makeDeps({ summaries, provider }).useCase.execute(params);
    await makeDeps({ summaries, provider }).useCase.execute({ ...params, kind: 'critic' });

    expect(summaries.rows.size).toBe(2);
    expect(await summaries.find({ ...params, kind: 'critic' })).not.toBeNull();
    expect(await summaries.find(params)).not.toBeNull();
  });

  it('разные платформы не перезаписывают друг друга', async () => {
    const provider = new FakeLlmProvider();

    await makeDeps({ summaries, provider }).useCase.execute(params);
    await makeDeps({ summaries, provider }).useCase.execute({
      ...params,
      platformSlug: 'playstation-5',
    });

    expect(summaries.rows.size).toBe(2);
  });

  it('анализ одной платформы не отменяет кеш другой', async () => {
    const provider = new FakeLlmProvider();

    await makeDeps({ summaries, provider }).useCase.execute(params);
    await makeDeps({ summaries, provider }).useCase.execute({
      ...params,
      platformSlug: 'playstation-5',
    });
    const again = await makeDeps({ summaries, provider }).useCase.execute(params);

    expect(again.status).toBe('skipped');
  });
});

describe('Наполнение запроса к модели', () => {
  it('модель получает ссылки, счётчики и заголовок', async () => {
    const { useCase, provider } = makeDeps({});
    await useCase.execute(params);

    const request = provider.requests[0]!;
    expect(request.gameTitle).toBe('Тестовая игра');
    expect(request.analyzedCount).toBe(3);
    expect(request.totalAvailable).toBe(3);
    expect(request.reviews.map((r) => r.ref)).toEqual(['r1', 'r2', 'r3']);
  });

  it('в события не попадают тексты отзывов', async () => {
    const secret = 'УНИКАЛЬНЫЙ_ТЕКСТ_ОТЗЫВА_98765';
    const { useCase, events } = makeDeps({
      reviews: [review('u1', 9, secret), review('u2', 3), review('u3', 7)],
    });

    await useCase.execute(params);

    expect(JSON.stringify(events.events)).not.toContain(secret);
  });
});
