import { describe, expect, it } from 'vitest';
import { ProcessGamePipeline } from '../../src/modules/ingestion/application/process-game-pipeline.js';
import { RecordingEventSink } from '../../src/modules/ingestion/domain/ingestion-events.js';
import { IngestionError } from '../../src/modules/ingestion/domain/ingestion-errors.js';

/**
 * Тесты конвейера обработки одной игры.
 *
 * Стадии подменены: проверяется их взаимодействие, а не внутренняя
 * работа. Ни сети, ни БД, ни обращений к OpenRouter.
 */

const GAME_ID = 'game-1';

interface StubOptions {
  readonly ingestFails?: Error;
  readonly criticFails?: Error;
  readonly userFails?: Error;
  readonly reviewCompleteness?: 'complete' | 'partial' | 'incomplete';
  readonly analysisDisabled?: boolean;
  readonly analysisStatus?: 'ok' | 'skipped' | 'failed' | 'insufficient_reviews';
  readonly analysisThrows?: Error;
}

/** Счётчики вызовов: по ним видно, какие стадии выполнялись. */
interface Calls {
  ingest: number;
  critic: number;
  user: number;
  analysis: number;
}

function makePipeline(options: StubOptions = {}): {
  pipeline: ProcessGamePipeline;
  calls: Calls;
  events: RecordingEventSink;
} {
  const calls: Calls = { ingest: 0, critic: 0, user: 0, analysis: 0 };
  const events = new RecordingEventSink();

  const pipeline = new ProcessGamePipeline({
    ingestGame: {
      execute: async () => {
        calls.ingest += 1;
        if (options.ingestFails) throw options.ingestFails;
        return { gameId: GAME_ID };
      },
    } as never,
    syncCriticReviews: {
      execute: async () => {
        calls.critic += 1;
        if (options.criticFails) throw options.criticFails;
        return { completeness: options.reviewCompleteness ?? 'complete' };
      },
    } as never,
    syncUserReviews: {
      execute: async () => {
        calls.user += 1;
        if (options.userFails) throw options.userFails;
        return { completeness: options.reviewCompleteness ?? 'complete' };
      },
    } as never,
    analyzeReviews: options.analysisDisabled
      ? null
      : ({
          execute: async () => {
            calls.analysis += 1;
            if (options.analysisThrows) throw options.analysisThrows;
            return { status: options.analysisStatus ?? 'ok' };
          },
        } as never),
    events,
    now: () => new Date('2026-09-09T00:00:00Z'),
    analysisPlatform: 'default',
  });

  return { pipeline, calls, events };
}

const params = { runId: 'run-1', sourceSlug: 'test-game' };

// ============================================================================
// Матрица исходов
// ============================================================================

describe('Успешный путь', () => {
  it('все стадии выполняются по порядку', async () => {
    const { pipeline, calls } = makePipeline();
    const result = await pipeline.execute(params);

    expect(result.outcome).toBe('success');
    expect(result.gameId).toBe(GAME_ID);
    expect(calls).toEqual({ ingest: 1, critic: 1, user: 1, analysis: 2 });
  });

  it('карта стадий отражает реально выполненное', async () => {
    const { pipeline } = makePipeline();
    const result = await pipeline.execute(params);

    expect(result.stageMap.fetchGame?.status).toBe('done');
    expect(result.stageMap.fetchReviews?.status).toBe('done');
    expect(result.stageMap.summarize?.status).toBe('done');
  });
});

describe('Сбой получения данных игры', () => {
  it('отзывы и разбор пропускаются', async () => {
    const { pipeline, calls } = makePipeline({
      ingestFails: new IngestionError('network', 'сеть недоступна'),
    });

    const result = await pipeline.execute(params);

    expect(result.outcome).toBe('failed');
    expect(result.gameId).toBeNull();
    // Без идентификатора игры последующие стадии бессмысленны
    expect(calls.critic).toBe(0);
    expect(calls.user).toBe(0);
    expect(calls.analysis).toBe(0);
  });

  it('игра не выглядит обработанной', async () => {
    const { pipeline } = makePipeline({
      ingestFails: new IngestionError('network', 'сбой'),
    });

    const result = await pipeline.execute(params);

    expect(result.stageMap.fetchGame?.status).toBe('failed');
    expect(result.stageMap.fetchReviews?.status).toBe('skipped');
    expect(result.stageMap.fetchReviews?.reason).toBe('ingestion_failed');
    expect(result.stageMap.summarize?.status).toBe('skipped');
  });
});

describe('Сбой получения отзывов', () => {
  it('разбор не запускается на отсутствующих отзывах', async () => {
    const failure = new IngestionError('network', 'источник недоступен');
    const { pipeline, calls } = makePipeline({
      criticFails: failure,
      userFails: failure,
    });

    const result = await pipeline.execute(params);

    expect(result.outcome).toBe('failed');
    // Данные игры сохранены
    expect(result.gameId).toBe(GAME_ID);
    expect(result.stageMap.fetchGame?.status).toBe('done');
    expect(result.stageMap.fetchReviews?.status).toBe('failed');
    // Разбор по пустому набору дал бы ложные выводы
    expect(calls.analysis).toBe(0);
    expect(result.stageMap.summarize?.reason).toBe('reviews_failed');
  });

  it('сбой одного вида отзывов не отменяет другой', async () => {
    const { pipeline, calls } = makePipeline({
      criticFails: new IngestionError('network', 'сбой'),
    });

    const result = await pipeline.execute(params);

    // Пользовательские отзывы получены — работа продолжается
    expect(calls.user).toBe(1);
    expect(result.stageMap.fetchReviews?.status).toBe('done');
    expect(result.stageMap.fetchReviews?.reason).toBe('incomplete_reviews');
    expect(calls.analysis).toBeGreaterThan(0);
  });

  it('неполный снимок помечается, но не считается отказом', async () => {
    const { pipeline } = makePipeline({ reviewCompleteness: 'partial' });
    const result = await pipeline.execute(params);

    expect(result.outcome).toBe('partial');
    expect(result.stageMap.fetchReviews?.status).toBe('done');
    expect(result.stageMap.fetchReviews?.reason).toBe('incomplete_reviews');
  });
});

describe('Сбой разбора отзывов', () => {
  it('игра остаётся обработанной частично', async () => {
    const { pipeline } = makePipeline({
      analysisThrows: new Error('провайдер недоступен'),
    });

    const result = await pipeline.execute(params);

    // Данные и отзывы сохранены: игру можно показывать
    expect(result.outcome).toBe('partial');
    expect(result.stageMap.fetchGame?.status).toBe('done');
    expect(result.stageMap.fetchReviews?.status).toBe('done');
    expect(result.stageMap.summarize?.status).toBe('failed');
  });

  it('неуспешный статус разбора тоже даёт partial', async () => {
    const { pipeline } = makePipeline({ analysisStatus: 'failed' });
    const result = await pipeline.execute(params);

    expect(result.outcome).toBe('partial');
    expect(result.stageMap.summarize?.status).toBe('failed');
  });
});

describe('Разбор выключен', () => {
  it('OpenRouter не вызывается, стадия пропускается', async () => {
    const { pipeline, calls } = makePipeline({ analysisDisabled: true });
    const result = await pipeline.execute(params);

    expect(calls.analysis).toBe(0);
    expect(result.stageMap.summarize?.status).toBe('skipped');
    // Причина отличима от сбоя провайдера
    expect(result.stageMap.summarize?.reason).toBe('llm_disabled');
  });

  it('данные и отзывы остаются успешными', async () => {
    const { pipeline } = makePipeline({ analysisDisabled: true });
    const result = await pipeline.execute(params);

    expect(result.stageMap.fetchGame?.status).toBe('done');
    expect(result.stageMap.fetchReviews?.status).toBe('done');
    // Выключенный разбор — не провал игры
    expect(result.outcome).toBe('partial');
    expect(result.errorCategory).toBeNull();
  });
});

describe('Повторный разбор', () => {
  it('совпадение входного хеша не считается сбоем', async () => {
    // 'skipped' от use case означает совпадение хеша: модель не вызывалась
    const { pipeline } = makePipeline({ analysisStatus: 'skipped' });
    const result = await pipeline.execute(params);

    expect(result.outcome).toBe('success');
    expect(result.stageMap.summarize?.status).toBe('done');
  });

  it('нехватка отзывов не считается сбоем', async () => {
    const { pipeline } = makePipeline({ analysisStatus: 'insufficient_reviews' });
    const result = await pipeline.execute(params);

    expect(result.stageMap.summarize?.status).toBe('skipped');
    expect(result.stageMap.summarize?.reason).toBe('insufficient_reviews');
    expect(result.outcome).toBe('partial');
  });
});

// ============================================================================
// События
// ============================================================================

describe('События стадий', () => {
  it('публикуются для каждой стадии', async () => {
    const { pipeline, events } = makePipeline();
    await pipeline.execute(params);

    const stageEvents = events.ofType('stage_finished');
    expect(stageEvents.map((e) => e.stage)).toEqual([
      'fetchGame',
      'fetchReviews',
      'summarize',
    ]);
  });

  it('содержат исход и длительность', async () => {
    const { pipeline, events } = makePipeline();
    await pipeline.execute(params);

    const first = events.ofType('stage_finished')[0]!;
    expect(first.outcome).toBe('success');
    expect(typeof first.durationMs).toBe('number');
  });

  it('пропущенные стадии тоже публикуются', async () => {
    const { pipeline, events } = makePipeline({
      ingestFails: new IngestionError('network', 'сбой'),
    });
    await pipeline.execute(params);

    const skipped = events
      .ofType('stage_finished')
      .filter((e) => e.outcome === 'skipped');
    expect(skipped).toHaveLength(2);
  });

  it('в события не попадают тексты и секреты', async () => {
    const secret = 'ТЕКСТ_ОТЗЫВА_НЕ_ДОЛЖЕН_ПОПАСТЬ';
    const { pipeline, events } = makePipeline({
      analysisThrows: new Error(`сбой при обработке: ${secret}`),
    });

    await pipeline.execute(params);

    // В событии только категория, не текст ошибки
    const serialized = JSON.stringify(events.ofType('stage_finished'));
    expect(serialized).not.toContain(secret);
  });
});
