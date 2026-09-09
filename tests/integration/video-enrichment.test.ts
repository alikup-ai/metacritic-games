import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbPool } from '../../src/shared/db/pool.js';
import { PostgresGameRepository } from '../../src/modules/catalog/infrastructure/postgres-game-repository.js';
import { PostgresVideoInsightRepository } from '../../src/modules/video/infrastructure/postgres-video-repository.js';
import { EnrichGameVideoUseCase } from '../../src/modules/video/application/enrich-game-video.js';
import { VideoError } from '../../src/modules/video/domain/video-ports.js';
import type {
  Transcript,
  VideoAnalysisContent,
  VideoCandidate,
} from '../../src/modules/video/domain/video.js';
import { createTestPool, setupSchema, truncateAll } from './helpers.js';

/**
 * Обогащение видеообзорами на РЕАЛЬНОЙ PostgreSQL.
 *
 * Внешние сервисы подменены: ни YouTube, ни OpenRouter не вызываются.
 */

let pool: DbPool;
let games: PostgresGameRepository;
let insights: PostgresVideoInsightRepository;
let gameId: string;

const hash = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');

const LIMITS = { minDurationSeconds: 240, maxDurationSeconds: 5400 };

function candidate(overrides: Partial<VideoCandidate> = {}): VideoCandidate {
  return {
    videoId: 'vid-1',
    title: 'Test Game Gameplay Review',
    channelTitle: 'Channel',
    url: 'https://www.youtube.com/watch?v=vid-1',
    publishedAt: '2026-01-01T00:00:00Z',
    viewCount: 500_000,
    durationSeconds: 1200,
    hasCaptions: true,
    ...overrides,
  };
}

const CONTENT: VideoAnalysisContent = {
  summary: 'Автор в целом доволен игрой, но отмечает технические проблемы.',
  liked: [{ text: 'Боевая система' }],
  disliked: [{ text: 'Просадки кадров' }],
  themes: ['боевая система', 'производительность'],
  conclusion: 'Игра стоит внимания, несмотря на огрехи.',
};

interface HarnessOptions {
  readonly candidates?: readonly VideoCandidate[];
  readonly searchError?: Error;
  readonly transcript?: Transcript | null;
  readonly transcriptError?: Error;
  readonly analysisError?: Error;
  readonly analysisDisabled?: boolean;
  readonly captionLanguages?: readonly string[];
}

interface Calls {
  search: number;
  transcript: number;
  analysis: number;
}

function makeUseCase(options: HarnessOptions = {}): {
  useCase: EnrichGameVideoUseCase;
  calls: Calls;
} {
  const calls: Calls = { search: 0, transcript: 0, analysis: 0 };

  const useCase = new EnrichGameVideoUseCase({
    search: {
      searchVideos: async () => {
        calls.search += 1;
        if (options.searchError) throw options.searchError;
        return options.candidates ?? [candidate()];
      },
      // Языки дорожек: подсказка для выбора расшифровки
      listCaptionLanguages: async () => options.captionLanguages ?? ['en'],
    },
    transcripts: {
      fetchTranscript: async () => {
        calls.transcript += 1;
        if (options.transcriptError) throw options.transcriptError;
        return options.transcript === undefined
          ? { source: 'official', text: 'Отличная игра, но есть баги', language: 'ru' }
          : options.transcript;
      },
    },
    analysis: options.analysisDisabled
      ? null
      : {
          model: 'test/model',
          analyzeTranscript: async () => {
            calls.analysis += 1;
            if (options.analysisError) throw options.analysisError;
            return CONTENT;
          },
        },
    insights,
    hash,
    limits: LIMITS,
    maxSearchResults: 10,
    promptVersion: 'v1',
    maxOutputTokens: 1500,
    maxTranscriptChars: 24_000,
  });

  return { useCase, calls };
}

beforeAll(async () => {
  pool = createTestPool();
  await setupSchema(pool);
  games = new PostgresGameRepository(pool);
  insights = new PostgresVideoInsightRepository(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  const { game } = await games.upsert({
    source: 'metacritic',
    sourceSlug: 'test-game',
    parserVersion: 'v1',
    title: 'Test Game',
    developerStatus: 'unknown',
  });
  gameId = game.id;
});

const params = () => ({ gameId, gameTitle: 'Test Game' });

describe('Успешное обогащение', () => {
  it('сохраняет ролик и разбор', async () => {
    const { useCase } = makeUseCase();
    const result = await useCase.execute(params());

    expect(result.status).toBe('ok');

    const saved = await insights.find(gameId);
    expect(saved?.status).toBe('ok');
    expect(saved?.videoId).toBe('vid-1');
    expect(saved?.videoUrl).toContain('youtube.com');
    expect(saved?.viewCount).toBe(500_000);
    expect(saved?.durationSeconds).toBe(1200);
    expect(saved?.summary).toBe(CONTENT.summary);
    expect(saved?.liked).toHaveLength(1);
    expect(saved?.themes).toHaveLength(2);
    expect(saved?.conclusion).toBeTruthy();
    expect(saved?.transcriptHash).toHaveLength(64);
  });

  it('текст расшифровки в базе не хранится', async () => {
    const { useCase } = makeUseCase();
    await useCase.execute(params());

    const { rows } = await pool.query<Record<string, unknown>>(
      'SELECT * FROM video_insights WHERE game_id = $1',
      [gameId],
    );

    // Достаточно отпечатка: сам текст не сохраняется
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain('Отличная игра, но есть баги');
  });
});

describe('Идемпотентность', () => {
  it('неизменная расшифровка не вызывает модель повторно', async () => {
    const { useCase, calls } = makeUseCase();

    await useCase.execute(params());
    expect(calls.analysis).toBe(1);

    const second = await useCase.execute(params());
    expect(second.status).toBe('unchanged');
    // Модель не вызывалась
    expect(calls.analysis).toBe(1);
  });

  it('изменённая расшифровка приводит к новому разбору', async () => {
    const first = makeUseCase();
    await first.useCase.execute(params());

    const second = makeUseCase({
      transcript: { source: 'official', text: 'СОВСЕМ ДРУГОЙ текст', language: 'ru' },
    });
    const result = await second.useCase.execute(params());

    expect(result.status).toBe('ok');
    expect(second.calls.analysis).toBe(1);
  });

  it('три прогона: разбор, пропуск по хешу, пересчёт после изменения', async () => {
    // Прогон 1: расшифровка -> хеш A -> модель -> результат сохранён
    const first = makeUseCase();
    const r1 = await first.useCase.execute(params());

    expect(r1.status).toBe('ok');
    expect(first.calls.analysis).toBe(1);

    const afterFirst = await insights.find(gameId);
    const hashA = afterFirst?.transcriptHash;
    expect(hashA).toHaveLength(64);

    // Прогон 2: та же расшифровка -> тот же хеш -> модель НЕ вызывается
    const second = makeUseCase();
    const r2 = await second.useCase.execute(params());

    expect(r2.status).toBe('unchanged');
    expect(second.calls.analysis).toBe(0);

    const afterSecond = await insights.find(gameId);
    // Существующий разбор переиспользован без изменений
    expect(afterSecond?.transcriptHash).toBe(hashA);
    expect(afterSecond?.summary).toBe(afterFirst?.summary);
    expect(afterSecond?.generatedAt.getTime()).toBe(afterFirst?.generatedAt.getTime());

    // Прогон 3: расшифровка изменилась -> хеш B -> модель вызывается снова
    const third = makeUseCase({
      transcript: { source: 'official', text: 'ИНОЙ текст расшифровки', language: 'ru' },
    });
    const r3 = await third.useCase.execute(params());

    expect(r3.status).toBe('ok');
    expect(third.calls.analysis).toBe(1);

    const afterThird = await insights.find(gameId);
    expect(afterThird?.transcriptHash).not.toBe(hashA);
  });

  it('смена ролика даёт новый хеш даже при том же тексте', async () => {
    const first = makeUseCase();
    await first.useCase.execute(params());
    const hashA = (await insights.find(gameId))?.transcriptHash;

    // Тот же текст, но другой ролик: идентификатор входит в ключ
    const second = makeUseCase({ candidates: [candidate({ videoId: 'vid-2' })] });
    await second.useCase.execute(params());

    expect((await insights.find(gameId))?.transcriptHash).not.toBe(hashA);
    expect(second.calls.analysis).toBe(1);
  });

  it('пропуск по хешу не обращается к модели вовсе', async () => {
    const first = makeUseCase();
    await first.useCase.execute(params());

    // Модель, которая упала бы при вызове: доказывает, что её не трогают
    const second = makeUseCase({
      analysisError: new VideoError('unavailable', 'не должно вызываться'),
    });
    const result = await second.useCase.execute(params());

    expect(result.status).toBe('unchanged');
    expect(second.calls.analysis).toBe(0);
  });

  it('повторная обработка не создаёт вторую запись', async () => {
    const { useCase } = makeUseCase();

    await useCase.execute(params());
    await useCase.execute(params());

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM video_insights WHERE game_id = $1',
      [gameId],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });
});

describe('Деградация', () => {
  it('исчерпание квоты не считается сбоем обработки', async () => {
    const { useCase } = makeUseCase({
      searchError: new VideoError('quota_exceeded', 'квота исчерпана'),
    });

    const result = await useCase.execute(params());

    expect(result.status).toBe('quota_exceeded');
    expect((await insights.find(gameId))?.status).toBe('quota_exceeded');
  });

  it('отсутствие подходящего ролика даёт skipped', async () => {
    const { useCase, calls } = makeUseCase({
      candidates: [candidate({ title: 'Совсем другая игра Trailer' })],
    });

    const result = await useCase.execute(params());

    expect(result.status).toBe('skipped');
    // Расшифровку запрашивать не для чего
    expect(calls.transcript).toBe(0);
  });

  it('отсутствие расшифровки сохраняет ссылку на ролик', async () => {
    const { useCase, calls } = makeUseCase({ transcript: null });

    const result = await useCase.execute(params());

    expect(result.status).toBe('skipped');
    expect(result.transcriptSource).toBe('metadata_only');

    const saved = await insights.find(gameId);
    // Ссылка полезна и без разбора
    expect(saved?.videoUrl).toContain('youtube.com');
    expect(saved?.summary).toBeNull();
    expect(calls.analysis).toBe(0);
  });

  it('сбой расшифровки не роняет обработку', async () => {
    const { useCase } = makeUseCase({
      transcriptError: new VideoError('unavailable', 'сбой'),
    });

    const result = await useCase.execute(params());
    expect(result.status).toBe('skipped');
    expect((await insights.find(gameId))?.videoId).toBe('vid-1');
  });

  it('сбой разбора сохраняет ролик и не закрепляет отпечаток', async () => {
    const { useCase } = makeUseCase({
      analysisError: new VideoError('unavailable', 'модель недоступна'),
    });

    const result = await useCase.execute(params());
    expect(result.status).toBe('failed');

    const saved = await insights.find(gameId);
    expect(saved?.videoId).toBe('vid-1');
    // Без отпечатка повторная попытка не блокируется
    expect(saved?.transcriptHash).toBeNull();
  });

  it('после сбоя разбора следующая попытка вызывает модель', async () => {
    const failing = makeUseCase({
      analysisError: new VideoError('unavailable', 'сбой'),
    });
    await failing.useCase.execute(params());

    const retry = makeUseCase();
    const result = await retry.useCase.execute(params());

    expect(result.status).toBe('ok');
    expect(retry.calls.analysis).toBe(1);
  });

  it('выключенный разбор сохраняет ролик без выводов', async () => {
    const { useCase, calls } = makeUseCase({ analysisDisabled: true });

    const result = await useCase.execute(params());

    expect(result.status).toBe('skipped');
    expect(calls.analysis).toBe(0);

    const saved = await insights.find(gameId);
    expect(saved?.videoId).toBe('vid-1');
    expect(saved?.lastError).toBe('analysis_disabled');
  });
});

describe('Целостность', () => {
  it('обогащение удаляется вместе с игрой', async () => {
    const { useCase } = makeUseCase();
    await useCase.execute(params());

    await pool.query('DELETE FROM games WHERE id = $1', [gameId]);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM video_insights WHERE game_id = $1',
      [gameId],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('новые источники расшифровки принимаются базой', async () => {
    // Миграция 011 расширила ограничение; прежние значения сохранились
    for (const source of [
      'official',
      'auto',
      'external_captions',
      'external_asr',
      'metadata_only',
      'none',
    ]) {
      await pool.query('DELETE FROM video_insights WHERE game_id = $1', [gameId]);
      await expect(
        pool.query(
          `INSERT INTO video_insights (game_id, status, transcript_source)
           VALUES ($1, 'skipped', $2)`,
          [gameId, source],
        ),
      ).resolves.toBeDefined();
    }
  });

  it('неизвестный источник расшифровки отвергается', async () => {
    await expect(
      pool.query(
        `INSERT INTO video_insights (game_id, status, transcript_source)
         VALUES ($1, 'skipped', 'выдуманный_источник')`,
        [gameId],
      ),
    ).rejects.toThrow();
  });

  it('успешная запись без отпечатка базой не принимается', async () => {
    // Ограничение video_insights_hash_required защищает идемпотентность
    await expect(
      pool.query(
        `INSERT INTO video_insights (game_id, status, transcript_source, transcript_hash)
         VALUES ($1, 'ok', 'official', NULL)`,
        [gameId],
      ),
    ).rejects.toThrow();
  });
});
