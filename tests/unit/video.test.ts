import { describe, expect, it, vi } from 'vitest';
import {
  scoreVideo,
  selectBestVideo,
  type VideoCandidate,
} from '../../src/modules/video/domain/video.js';
import {
  parseIsoDuration,
  toYouTubeError,
  YouTubeSearchAdapter,
} from '../../src/modules/video/infrastructure/youtube-search.js';
import {
  extractTranscriptText,
  YouTubeTranscriptAdapter,
} from '../../src/modules/video/infrastructure/youtube-transcript.js';
import { VideoError } from '../../src/modules/video/domain/video-ports.js';

/**
 * Отбор видео и разбор ответов внешних сервисов.
 *
 * Реальный YouTube не вызывается: fetch подменяется. Ключ фиктивный.
 */

const FAKE_KEY = 'test-youtube-key-not-real';
const LIMITS = { minDurationSeconds: 240, maxDurationSeconds: 5400 };

function video(overrides: Partial<VideoCandidate> & { videoId: string }): VideoCandidate {
  return {
    title: 'The Witcher 3 Gameplay Review',
    channelTitle: 'Some Channel',
    url: `https://www.youtube.com/watch?v=${overrides.videoId}`,
    publishedAt: '2026-01-01T00:00:00Z',
    viewCount: 100_000,
    durationSeconds: 900,
    hasCaptions: null,
    ...overrides,
  };
}

// ============================================================================
// Отбор
// ============================================================================

describe('Оценка пригодности ролика', () => {
  it('подходящий ролик получает оценку', () => {
    const result = scoreVideo('The Witcher 3', video({ videoId: 'a' }), LIMITS);

    expect(result.rejectedReason).toBeNull();
    expect(result.score).toBeGreaterThan(0);
  });

  it('ролик о другой игре отклоняется', () => {
    const result = scoreVideo(
      'The Witcher 3',
      video({ videoId: 'a', title: 'Cyberpunk 2077 Gameplay' }),
      LIMITS,
    );

    expect(result.rejectedReason).toBe('title_mismatch');
  });

  it('трейлер отклоняется: это не разбор', () => {
    const result = scoreVideo(
      'The Witcher 3',
      video({ videoId: 'a', title: 'The Witcher 3 Official Trailer' }),
      LIMITS,
    );

    expect(result.rejectedReason).toBe('not_a_playthrough');
  });

  it('короткий ролик отклоняется — речи для разбора нет', () => {
    const result = scoreVideo(
      'The Witcher 3',
      video({ videoId: 'a', durationSeconds: 45 }),
      LIMITS,
    );

    expect(result.rejectedReason).toBe('too_short');
  });

  it('слишком длинный ролик отклоняется', () => {
    const result = scoreVideo(
      'The Witcher 3',
      video({ videoId: 'a', durationSeconds: 36_000 }),
      LIMITS,
    );

    expect(result.rejectedReason).toBe('too_long');
  });

  it('неизвестная длительность не отбраковывает ролик', () => {
    const result = scoreVideo(
      'The Witcher 3',
      video({ videoId: 'a', durationSeconds: null }),
      LIMITS,
    );

    // Выдумывать длительность нельзя, но и терять ролик незачем
    expect(result.rejectedReason).toBeNull();
  });

  it('популярность повышает оценку', () => {
    const popular = scoreVideo(
      'The Witcher 3',
      video({ videoId: 'a', viewCount: 5_000_000 }),
      LIMITS,
    );
    const rare = scoreVideo(
      'The Witcher 3',
      video({ videoId: 'b', viewCount: 100 }),
      LIMITS,
    );

    expect(popular.score).toBeGreaterThan(rare.score);
  });

  it('наличие субтитров решающе: без них разбор невозможен', () => {
    const withCaptions = scoreVideo(
      'The Witcher 3',
      video({ videoId: 'a', hasCaptions: true, viewCount: 1000 }),
      LIMITS,
    );
    const withoutCaptions = scoreVideo(
      'The Witcher 3',
      video({ videoId: 'b', hasCaptions: false, viewCount: 9_000_000 }),
      LIMITS,
    );

    // Ролик с субтитрами полезнее более популярного, но безмолвного
    expect(withCaptions.score).toBeGreaterThan(withoutCaptions.score);
  });

  it('неизвестный признак субтитров не даёт преимущества', () => {
    const unknown = scoreVideo('The Witcher 3', video({ videoId: 'a', hasCaptions: null }), LIMITS);
    const absent = scoreVideo('The Witcher 3', video({ videoId: 'b', hasCaptions: false }), LIMITS);

    expect(unknown.score).toBe(absent.score);
  });

  it('признак разбора в заголовке повышает оценку', () => {
    const marked = scoreVideo(
      'The Witcher 3',
      video({ videoId: 'a', title: 'The Witcher 3 — полное прохождение' }),
      LIMITS,
    );
    const plain = scoreVideo(
      'The Witcher 3',
      video({ videoId: 'b', title: 'The Witcher 3' }),
      LIMITS,
    );

    expect(marked.score).toBeGreaterThan(plain.score);
  });
});

describe('Выбор лучшего ролика', () => {
  it('выбирает самый популярный из подходящих', () => {
    const best = selectBestVideo(
      'The Witcher 3',
      [
        video({ videoId: 'low', viewCount: 1000 }),
        video({ videoId: 'high', viewCount: 9_000_000 }),
        video({ videoId: 'mid', viewCount: 50_000 }),
      ],
      LIMITS,
    );

    expect(best?.candidate.videoId).toBe('high');
  });

  it('выбор воспроизводим', () => {
    const candidates = [
      video({ videoId: 'a', viewCount: 1000 }),
      video({ videoId: 'b', viewCount: 1000 }),
      video({ videoId: 'c', viewCount: 1000 }),
    ];

    const first = selectBestVideo('The Witcher 3', candidates, LIMITS);
    const second = selectBestVideo('The Witcher 3', [...candidates].reverse(), LIMITS);

    // При равной оценке порядок решает идентификатор
    expect(first?.candidate.videoId).toBe(second?.candidate.videoId);
  });

  it('при отсутствии подходящих возвращает null', () => {
    const best = selectBestVideo(
      'The Witcher 3',
      [video({ videoId: 'a', title: 'Cyberpunk Trailer' })],
      LIMITS,
    );

    expect(best).toBeNull();
  });

  it('пустой список даёт null', () => {
    expect(selectBestVideo('The Witcher 3', [], LIMITS)).toBeNull();
  });
});

// ============================================================================
// Разбор ответов YouTube
// ============================================================================

describe('Разбор длительности', () => {
  it('разбирает часы, минуты и секунды', () => {
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723);
    expect(parseIsoDuration('PT15M')).toBe(900);
    expect(parseIsoDuration('PT45S')).toBe(45);
  });

  it('неразобранное значение даёт null, а не ноль', () => {
    // Выдуманная длительность исказила бы отбор
    expect(parseIsoDuration('не-длительность')).toBeNull();
    expect(parseIsoDuration(null)).toBeNull();
    expect(parseIsoDuration(undefined)).toBeNull();
  });
});

describe('Классификация ошибок YouTube', () => {
  it('403 означает исчерпание квоты — мягкое отключение', () => {
    const error = toYouTubeError(403);
    expect(error.category).toBe('quota_exceeded');
    expect(error.retryable).toBe(false);
  });

  it('429 тоже считается исчерпанием квоты', () => {
    expect(toYouTubeError(429).category).toBe('quota_exceeded');
  });

  it('5xx повторяемы', () => {
    const error = toYouTubeError(503);
    expect(error.category).toBe('unavailable');
    expect(error.retryable).toBe(true);
  });

  it('прочие 4xx не повторяются', () => {
    const error = toYouTubeError(400);
    expect(error.category).toBe('client_error');
    expect(error.retryable).toBe(false);
  });
});

describe('Адаптер поиска', () => {
  const searchBody = {
    items: [{ id: { videoId: 'vid1' }, snippet: { title: 'T', channelTitle: 'C' } }],
  };
  const videosBody = {
    items: [
      {
        id: 'vid1',
        snippet: {
          title: 'The Witcher 3 Review',
          channelTitle: 'Channel',
          publishedAt: '2026-01-01T00:00:00Z',
        },
        statistics: { viewCount: '123456' },
        contentDetails: { duration: 'PT20M', caption: 'true' },
      },
    ],
  };

  function makeAdapter(fetchImpl: typeof fetch): YouTubeSearchAdapter {
    return new YouTubeSearchAdapter({
      apiKey: FAKE_KEY,
      timeoutMs: 5000,
      fetchImpl,
      searchEndpoint: 'https://youtube.test/search',
      videosEndpoint: 'https://youtube.test/videos',
    });
  }

  it('без ключа адаптер не создаётся', () => {
    expect(
      () => new YouTubeSearchAdapter({ apiKey: '', timeoutMs: 1000 }),
    ).toThrow(/YOUTUBE_API_KEY/);
  });

  it('приводит ответ к доменной форме', async () => {
    const fetchImpl = vi.fn(async (url: unknown) =>
      new Response(
        JSON.stringify(String(url).includes('/search') ? searchBody : videosBody),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await makeAdapter(fetchImpl).searchVideos({
      gameTitle: 'The Witcher 3',
      maxResults: 5,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      videoId: 'vid1',
      viewCount: 123456,
      durationSeconds: 1200,
      hasCaptions: true,
      url: 'https://www.youtube.com/watch?v=vid1',
    });
  });

  it('пустой поиск не приводит ко второму запросу', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await makeAdapter(fetchImpl).searchVideos({
      gameTitle: 'Nothing',
      maxResults: 5,
    });

    expect(result).toEqual([]);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('исчерпание квоты даёт типизированную ошибку', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;

    await expect(
      makeAdapter(fetchImpl).searchVideos({ gameTitle: 'X', maxResults: 5 }),
    ).rejects.toMatchObject({ category: 'quota_exceeded' });
  });

  it('сбой сервиса даёт unavailable', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;

    await expect(
      makeAdapter(fetchImpl).searchVideos({ gameTitle: 'X', maxResults: 5 }),
    ).rejects.toMatchObject({ category: 'unavailable' });
  });

  it('ключ не попадает в сообщение об ошибке', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;

    const error = await makeAdapter(fetchImpl)
      .searchVideos({ gameTitle: 'X', maxResults: 5 })
      .catch((e: VideoError) => e);

    expect((error as Error).message).not.toContain(FAKE_KEY);
  });
});

// ============================================================================
// Расшифровка
// ============================================================================

describe('Извлечение текста субтитров', () => {
  it('убирает разметку и декодирует сущности', () => {
    const xml = `<transcript>
      <text start="0">Hello &amp; welcome</text>
      <text start="3">to the &quot;game&quot;</text>
    </transcript>`;

    expect(extractTranscriptText(xml)).toBe('Hello & welcome to the "game"');
  });

  it('пустой ответ даёт пустую строку', () => {
    expect(extractTranscriptText('<transcript></transcript>')).toBe('');
  });
});

describe('Адаптер расшифровки', () => {
  function makeAdapter(fetchImpl: typeof fetch): YouTubeTranscriptAdapter {
    return new YouTubeTranscriptAdapter({
      timeoutMs: 5000,
      fetchImpl,
      endpoint: 'https://youtube.test/timedtext',
      languages: ['en'],
    });
  }

  it('возвращает официальные субтитры', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('<text start="0">Great game</text>', { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await makeAdapter(fetchImpl).fetchTranscript({ videoId: 'v1' });

    expect(result?.source).toBe('official');
    expect(result?.text).toBe('Great game');
  });

  it('отсутствие субтитров даёт null, а не ошибку', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch;

    // Это штатный исход: страница игры от него не страдает
    expect(await makeAdapter(fetchImpl).fetchTranscript({ videoId: 'v1' })).toBeNull();
  });

  it('пустые субтитры считаются отсутствующими', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('<transcript></transcript>', { status: 200 }),
    ) as unknown as typeof fetch;

    expect(await makeAdapter(fetchImpl).fetchTranscript({ videoId: 'v1' })).toBeNull();
  });

  it('сетевой сбой не роняет обработку', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;

    expect(await makeAdapter(fetchImpl).fetchTranscript({ videoId: 'v1' })).toBeNull();
  });
});
