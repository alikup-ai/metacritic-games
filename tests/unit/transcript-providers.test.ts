import { describe, expect, it, vi } from 'vitest';
import { pickTranscriptLanguage } from '../../src/modules/video/domain/video.js';
import {
  SupadataTranscriptAdapter,
  toSupadataError,
} from '../../src/modules/video/infrastructure/supadata-transcript.js';
import { FallbackTranscriptAdapter } from '../../src/modules/video/infrastructure/fallback-transcript.js';
import { YouTubeTranscriptAdapter } from '../../src/modules/video/infrastructure/youtube-transcript.js';
import { VideoError, type TranscriptPort } from '../../src/modules/video/domain/video-ports.js';
import type { Transcript } from '../../src/modules/video/domain/video.js';

/**
 * Поставщики расшифровки.
 *
 * Реальные сервисы не вызываются: fetch подменяется, ключ фиктивный.
 */

const FAKE_KEY = 'test-supadata-key-not-real';

function makeSupadata(fetchImpl: typeof fetch, options = {}): SupadataTranscriptAdapter {
  return new SupadataTranscriptAdapter({
    apiKey: FAKE_KEY,
    timeoutMs: 5000,
    fetchImpl,
    endpoint: 'https://supadata.test/transcript',
    ...options,
  });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// ============================================================================
// 12. Выбор языка
// ============================================================================

describe('Выбор языка расшифровки', () => {
  it('предпочитает английский', () => {
    expect(pickTranscriptLanguage({ available: ['de', 'en', 'fr'] })).toBe('en');
  });

  it('затем русский', () => {
    expect(pickTranscriptLanguage({ available: ['de', 'ru', 'fr'] })).toBe('ru');
  });

  it('затем язык из конфигурации', () => {
    expect(
      pickTranscriptLanguage({ available: ['de', 'fr'], fallbackLanguage: 'fr' }),
    ).toBe('fr');
  });

  it('иначе первый доступный — немецкий не теряется', () => {
    // Реальный случай: у ролика jJdzHtYTpu0 только немецкие дорожки
    expect(pickTranscriptLanguage({ available: ['de'] })).toBe('de');
  });

  it('региональный код считается тем же языком', () => {
    expect(pickTranscriptLanguage({ available: ['en-US', 'de'] })).toBe('en-US');
  });

  it('пустой список даёт null', () => {
    expect(pickTranscriptLanguage({ available: [] })).toBeNull();
  });
});

describe('Адаптер timedtext использует фактические языки', () => {
  it('запрашивает язык из доступных дорожек, а не угаданный', async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      requested.push(new URL(String(url)).searchParams.get('lang') ?? '');
      return new Response('<text start="0">Guten Tag</text>', { status: 200 });
    }) as unknown as typeof fetch;

    const adapter = new YouTubeTranscriptAdapter({
      timeoutMs: 5000,
      fetchImpl,
      endpoint: 'https://youtube.test/timedtext',
      // У ролика только немецкие дорожки
      captionLanguages: async () => ['de'],
    });

    const result = await adapter.fetchTranscript({ videoId: 'v1' });

    expect(requested[0]).toBe('de');
    expect(result?.text).toBe('Guten Tag');
  });

  it('без списка дорожек остаётся прежний перебор', async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      requested.push(new URL(String(url)).searchParams.get('lang') ?? '');
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;

    const adapter = new YouTubeTranscriptAdapter({
      timeoutMs: 5000,
      fetchImpl,
      endpoint: 'https://youtube.test/timedtext',
    });

    await adapter.fetchTranscript({ videoId: 'v1' });
    expect(requested).toContain('en');
  });
});

// ============================================================================
// 1-3. Успешные ответы Supadata
// ============================================================================

describe('Supadata: успешная расшифровка', () => {
  it('возвращает текст и язык', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ content: 'Отличная игра', lang: 'ru', availableLangs: ['ru', 'en'] }),
    ) as unknown as typeof fetch;

    const result = await makeSupadata(fetchImpl).fetchTranscript({ videoId: 'v1' });

    expect(result?.text).toBe('Отличная игра');
    expect(result?.language).toBe('ru');
  });

  it('источник помечается как внешние субтитры', async () => {
    const fetchImpl = vi.fn(async () => json({ content: 'text', lang: 'en' })) as unknown as typeof fetch;

    const result = await makeSupadata(fetchImpl).fetchTranscript({ videoId: 'v1' });

    // Сервис не сообщает, взяты субтитры у площадки или речь распознана
    // им самим. Происхождение не выдумывается — используется осторожное
    // значение.
    expect(result?.source).toBe('external_captions');
  });

  it('ключ уходит только заголовком x-api-key', async () => {
    const fetchImpl = vi.fn(async () => json({ content: 'text' })) as unknown as typeof fetch;

    await makeSupadata(fetchImpl).fetchTranscript({ videoId: 'v1' });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;

    expect(headers['x-api-key']).toBe(FAKE_KEY);
    // В адресе ключа быть не должно
    expect(String(url)).not.toContain(FAKE_KEY);
  });

  it('пустой текст считается отсутствием расшифровки', async () => {
    const fetchImpl = vi.fn(async () => json({ content: '   ', lang: 'en' })) as unknown as typeof fetch;

    expect(await makeSupadata(fetchImpl).fetchTranscript({ videoId: 'v1' })).toBeNull();
  });

  it('206 означает отсутствие расшифровки, а не сбой', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: 'transcript-unavailable' }, 206),
    ) as unknown as typeof fetch;

    expect(await makeSupadata(fetchImpl).fetchTranscript({ videoId: 'v1' })).toBeNull();
  });
});

// ============================================================================
// 4-7. Сбои Supadata
// ============================================================================

describe('Supadata: обработка сбоев', () => {
  const call = async (status: number, body: unknown = {}, headers = {}) => {
    const fetchImpl = vi.fn(async () => json(body, status, headers)) as unknown as typeof fetch;
    return makeSupadata(fetchImpl)
      .fetchTranscript({ videoId: 'v1' })
      .catch((e: VideoError) => e) as Promise<VideoError>;
  };

  it('401 не повторяется: ключ неверен', async () => {
    const error = await call(401, { error: 'unauthorized' });
    expect(error.category).toBe('client_error');
    expect(error.retryable).toBe(false);
  });

  it('403 не повторяется', async () => {
    const error = await call(403, { error: 'forbidden' });
    expect(error.category).toBe('client_error');
    expect(error.retryable).toBe(false);
  });

  it('429 считается исчерпанием лимита и не повторяется', async () => {
    const error = await call(429, {}, { 'retry-after': '30' });
    expect(error.category).toBe('quota_exceeded');
    expect(error.retryable).toBe(false);
  });

  it('402 и limit-exceeded — тоже лимит', async () => {
    expect((await call(402)).category).toBe('quota_exceeded');
    expect((await call(400, { error: 'limit-exceeded' })).category).toBe('quota_exceeded');
  });

  it('5xx повторяемы', async () => {
    const error = await call(503);
    expect(error.category).toBe('unavailable');
    expect(error.retryable).toBe(true);
  });

  it('404 — ролик не найден', async () => {
    expect((await call(404)).category).toBe('not_found');
  });

  it('таймаут распознаётся', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    }) as unknown as typeof fetch;

    const error = (await makeSupadata(fetchImpl, { timeoutMs: 20 })
      .fetchTranscript({ videoId: 'v1' })
      .catch((e: VideoError) => e)) as VideoError;

    expect(error.category).toBe('timeout');
    expect(error.retryable).toBe(true);
  });

  it('ключ не попадает в сообщения об ошибках', async () => {
    const error = await call(500);
    expect(error.message).not.toContain(FAKE_KEY);
  });

  it('без ключа адаптер не создаётся', () => {
    expect(
      () => new SupadataTranscriptAdapter({ apiKey: '', timeoutMs: 1000 }),
    ).toThrow(/SUPADATA_API_KEY/);
  });
});

describe('Классификация ответов Supadata', () => {
  it('коды сопоставляются с категориями', async () => {
    expect((await toSupadataError(json({}, 401))).category).toBe('client_error');
    expect((await toSupadataError(json({}, 429))).category).toBe('quota_exceeded');
    expect((await toSupadataError(json({}, 500))).category).toBe('unavailable');
  });
});

// ============================================================================
// 8-10. Цепочка поставщиков
// ============================================================================

/** Поставщик с заданным поведением. */
function stub(
  behaviour: Transcript | null | Error,
  counter: { calls: number },
): TranscriptPort {
  return {
    fetchTranscript: async () => {
      counter.calls += 1;
      if (behaviour instanceof Error) throw behaviour;
      return behaviour;
    },
  };
}

describe('Цепочка поставщиков', () => {
  const good: Transcript = { source: 'official', text: 'текст', language: 'en' };
  const external: Transcript = {
    source: 'external_captions',
    text: 'внешний текст',
    language: 'de',
  };

  it('первый успех прекращает перебор', async () => {
    const a = { calls: 0 };
    const b = { calls: 0 };

    const result = await new FallbackTranscriptAdapter({
      providers: [
        { name: 'first', provider: stub(good, a) },
        { name: 'second', provider: stub(external, b) },
      ],
    }).fetchTranscript({ videoId: 'v1' });

    expect(result?.source).toBe('official');
    // Платный источник не тревожится, если бесплатный дал результат
    expect(b.calls).toBe(0);
  });

  it('пустой результат первого ведёт ко второму', async () => {
    const a = { calls: 0 };
    const b = { calls: 0 };

    const result = await new FallbackTranscriptAdapter({
      providers: [
        { name: 'timedtext', provider: stub(null, a) },
        { name: 'supadata', provider: stub(external, b) },
      ],
    }).fetchTranscript({ videoId: 'v1' });

    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
    expect(result?.source).toBe('external_captions');
  });

  it('сбой первого не отменяет второго', async () => {
    const a = { calls: 0 };
    const b = { calls: 0 };

    const result = await new FallbackTranscriptAdapter({
      providers: [
        { name: 'timedtext', provider: stub(new VideoError('timeout', 'сбой'), a) },
        { name: 'supadata', provider: stub(external, b) },
      ],
    }).fetchTranscript({ videoId: 'v1' });

    expect(result?.text).toBe('внешний текст');
  });

  it('оба недоступны — прежний null', async () => {
    const a = { calls: 0 };
    const b = { calls: 0 };

    const result = await new FallbackTranscriptAdapter({
      providers: [
        { name: 'timedtext', provider: stub(null, a) },
        { name: 'supadata', provider: stub(new VideoError('unavailable', 'x'), b) },
      ],
    }).fetchTranscript({ videoId: 'v1' });

    expect(result).toBeNull();
  });

  it('единственный поставщик работает как раньше', async () => {
    // Так выглядит цепочка без ключа Supadata
    const a = { calls: 0 };

    const result = await new FallbackTranscriptAdapter({
      providers: [{ name: 'timedtext', provider: stub(null, a) }],
    }).fetchTranscript({ videoId: 'v1' });

    expect(a.calls).toBe(1);
    expect(result).toBeNull();
  });

  it('пустой текст считается отсутствием и ведёт дальше', async () => {
    const a = { calls: 0 };
    const b = { calls: 0 };

    const result = await new FallbackTranscriptAdapter({
      providers: [
        {
          name: 'first',
          provider: stub({ source: 'auto', text: '   ', language: 'en' }, a),
        },
        { name: 'second', provider: stub(external, b) },
      ],
    }).fetchTranscript({ videoId: 'v1' });

    expect(result?.source).toBe('external_captions');
  });
});

// ============================================================================
// Стоимость: число внешних запросов на одно обогащение
// ============================================================================

describe('Число внешних запросов ограничено', () => {
  /** Считает обращения каждого поставщика. */
  function makeChain(options: {
    captionLanguages?: string[] | null;
    supadataStatus?: number;
    supadataBody?: unknown;
  }) {
    const counts = { timedtext: 0, supadata: 0 };

    const timedtext = new YouTubeTranscriptAdapter({
      timeoutMs: 5000,
      endpoint: 'https://yt.test/timedtext',
      fetchImpl: (async () => {
        counts.timedtext += 1;
        // Пустой ответ: так ведёт себя настоящий timedtext
        return new Response('', { status: 404 });
      }) as unknown as typeof fetch,
      ...(options.captionLanguages !== null
        ? { captionLanguages: async () => options.captionLanguages ?? ['de'] }
        : {}),
    });

    const supadata = makeSupadata(
      (async () => {
        counts.supadata += 1;
        return json(options.supadataBody ?? { content: 'текст', lang: 'de' },
          options.supadataStatus ?? 200);
      }) as unknown as typeof fetch,
    );

    const chain = new FallbackTranscriptAdapter({
      providers: [
        { name: 'timedtext', provider: timedtext },
        { name: 'supadata', provider: supadata },
      ],
    });

    return { chain, counts };
  }

  it('платный поставщик вызывается ровно один раз', async () => {
    const { chain, counts } = makeChain({ captionLanguages: ['de'] });
    await chain.fetchTranscript({ videoId: 'v1' });

    // Каждое обращение стоит денег: повторов быть не должно
    expect(counts.supadata).toBe(1);
  });

  it('известный язык ограничивает timedtext двумя запросами', async () => {
    const { chain, counts } = makeChain({ captionLanguages: ['de'] });
    await chain.fetchTranscript({ videoId: 'v1' });

    // Один язык × два вида дорожек (ручные и автоматические)
    expect(counts.timedtext).toBe(2);
  });

  it('без списка языков перебор всё равно ограничен', async () => {
    const { chain, counts } = makeChain({ captionLanguages: [] });
    await chain.fetchTranscript({ videoId: 'v1' });

    // Два предпочитаемых языка × два вида — верхняя граница
    expect(counts.timedtext).toBe(4);
    expect(counts.supadata).toBe(1);
  });

  it('отсутствие расшифровки не вызывает повторов', async () => {
    const { chain, counts } = makeChain({
      captionLanguages: ['de'],
      supadataStatus: 206,
      supadataBody: { error: 'transcript-unavailable' },
    });

    const result = await chain.fetchTranscript({ videoId: 'v1' });

    expect(result).toBeNull();
    // Ни один поставщик не пробуется дважды
    expect(counts.supadata).toBe(1);
    expect(counts.timedtext).toBe(2);
  });

  it('повторяемая ошибка не порождает повторов внутри операции', async () => {
    const { chain, counts } = makeChain({
      captionLanguages: ['de'],
      supadataStatus: 503,
    });

    await chain.fetchTranscript({ videoId: 'v1' });

    // Повтор — решение вызывающего, а не адаптера: обогащение
    // необязательное, и настойчивость здесь стоила бы денег
    expect(counts.supadata).toBe(1);
  });

  it('суммарно не более пяти внешних запросов на одно обогащение', async () => {
    const { chain, counts } = makeChain({ captionLanguages: [] });
    await chain.fetchTranscript({ videoId: 'v1' });

    // Верхняя граница: 4 timedtext + 1 Supadata
    expect(counts.timedtext + counts.supadata).toBeLessThanOrEqual(5);
  });
});
