import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MetacriticHttpClient,
  parseRetryAfter,
} from '../../src/modules/ingestion/infrastructure/metacritic-http-client.js';
import { IngestionError } from '../../src/modules/ingestion/domain/ingestion-errors.js';
import { TokenBucketRateLimiter } from '../../src/shared/http/rate-limiter.js';
import { StructuredLogger } from '../../src/shared/logging/logger.js';

/**
 * Тесты HTTP-клиента. Сеть не используется: fetch и sleep подменяются.
 */

const UA = 'MetacriticGamesBot/0.1 (+https://example.test)';

/** Собирает клиента с мгновенным sleep и лимитером без задержек. */
function makeClient(
  responses: (Response | Error)[],
  overrides: Partial<ConstructorParameters<typeof MetacriticHttpClient>[0]> = {},
) {
  const calls: string[] = [];
  const sleepCalls: number[] = [];
  let index = 0;

  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url));
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return next as Response;
  }) as unknown as typeof fetch;

  const client = new MetacriticHttpClient({
    userAgent: UA,
    fetchImpl,
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
    },
    // Лимитер с большой скоростью: в тестах реальные паузы не нужны
    rateLimiter: new TokenBucketRateLimiter({
      requestsPerSecond: 1000,
      sleep: async () => undefined,
    }),
    random: () => 0,
    ...overrides,
  });

  return { client, calls, sleepCalls, fetchImpl };
}

const htmlResponse = (body = '<html><body>ok</body></html>', status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/html' } });

describe('Успешный запрос', () => {
  it('возвращает тело и метаданные', async () => {
    const { client } = makeClient([htmlResponse('<html>page</html>')]);
    const result = await client.get('/game/');

    expect(result.status).toBe(200);
    expect(result.body).toContain('page');
    expect(result.attempts).toBe(1);
    expect(result.url).toBe('https://www.metacritic.com/game/');
  });

  it('передаёт User-Agent из конфигурации', async () => {
    const { client, fetchImpl } = makeClient([htmlResponse()]);
    await client.get('/game/');

    const init = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1] as
      | RequestInit
      | undefined;
    const headers = init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(UA);
  });

  it('требует непустой User-Agent — бот обязан представляться', () => {
    expect(() => new MetacriticHttpClient({ userAgent: '  ' })).toThrow(/userAgent/);
  });

  it('отвергает User-Agent вне Latin-1 (HTTP-заголовки — ByteString)', () => {
    // Найдено live-тестом: кириллица в заголовке роняет fetch с TypeError
    // уже во время запроса. Проверка перенесена на этап сборки клиента.
    expect(
      () => new MetacriticHttpClient({ userAgent: 'Бот/0.1 (проект)' }),
    ).toThrow(/Latin-1/);
  });

  it('собирает абсолютный URL из пути', () => {
    const { client } = makeClient([htmlResponse()]);
    expect(client.resolveUrl('/browse/')).toBe('https://www.metacritic.com/browse/');
    expect(client.resolveUrl('https://other.test/x')).toBe('https://other.test/x');
  });
});

describe('403 — блокировка', () => {
  it('НЕ повторяется', async () => {
    const { client, calls } = makeClient([new Response('denied', { status: 403 })]);

    await expect(client.get('/game/')).rejects.toMatchObject({
      category: 'blocked',
    });
    // Ровно одна попытка: повтор при блокировке усугубляет ситуацию
    expect(calls).toHaveLength(1);
  });

  it('помечается как неповторяемая ошибка', async () => {
    const { client } = makeClient([new Response('denied', { status: 403 })]);

    const error = await client.get('/game/').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IngestionError);
    expect((error as IngestionError).retryable).toBe(false);
    expect((error as IngestionError).context.status).toBe(403);
  });
});

describe('429 — превышение лимита', () => {
  it('повторяется и учитывает Retry-After в секундах', async () => {
    const { client, sleepCalls, calls } = makeClient([
      new Response('slow down', { status: 429, headers: { 'retry-after': '5' } }),
      htmlResponse('<html>ok</html>'),
    ]);

    const result = await client.get('/game/');

    expect(result.status).toBe(200);
    expect(calls).toHaveLength(2);
    // Пауза берётся из Retry-After, а не из экспоненты
    expect(sleepCalls[0]).toBe(5000);
  });

  it('ограничивает чрезмерный Retry-After', async () => {
    const { client, sleepCalls } = makeClient(
      [
        new Response('slow', { status: 429, headers: { 'retry-after': '99999' } }),
        htmlResponse(),
      ],
      { maxRetryAfterMs: 30_000 },
    );

    await client.get('/game/');
    expect(sleepCalls[0]).toBe(30_000);
  });

  it('без Retry-After использует экспоненциальную задержку', async () => {
    const { client, sleepCalls } = makeClient([
      new Response('slow', { status: 429 }),
      htmlResponse(),
    ]);

    await client.get('/game/');
    expect(sleepCalls[0]).toBe(1000);
  });
});

describe('5xx — ошибка источника', () => {
  it('повторяется и завершается успехом', async () => {
    const { client, calls } = makeClient([
      new Response('boom', { status: 500 }),
      new Response('boom', { status: 503 }),
      htmlResponse('<html>recovered</html>'),
    ]);

    const result = await client.get('/game/');

    expect(result.body).toContain('recovered');
    expect(calls).toHaveLength(3);
  });

  it('исчерпав попытки, бросает ошибку категории server_error', async () => {
    const { client, calls } = makeClient([new Response('boom', { status: 500 })], {
      maxAttempts: 3,
    });

    await expect(client.get('/game/')).rejects.toMatchObject({
      category: 'server_error',
    });
    expect(calls).toHaveLength(3);
  });

  it('использует экспоненциальную задержку с ростом', async () => {
    const { client, sleepCalls } = makeClient([new Response('x', { status: 500 })], {
      maxAttempts: 3,
    });

    await client.get('/game/').catch(() => undefined);
    // 1000, затем 2000 — экспонента (jitter отключён random: () => 0)
    expect(sleepCalls).toEqual([1000, 2000]);
  });

  it('джиттер добавляется к задержке', async () => {
    const { client, sleepCalls } = makeClient([new Response('x', { status: 500 })], {
      maxAttempts: 2,
      random: () => 1,
    });

    await client.get('/game/').catch(() => undefined);
    // 1000 + 30% = 1300
    expect(sleepCalls[0]).toBe(1300);
  });
});

describe('Прочие 4xx', () => {
  it('404 не повторяется', async () => {
    const { client, calls } = makeClient([new Response('missing', { status: 404 })]);

    await expect(client.get('/game/x/')).rejects.toMatchObject({
      category: 'client_error',
    });
    expect(calls).toHaveLength(1);
  });
});

describe('Сетевые ошибки', () => {
  it('повторяются ограниченное число раз', async () => {
    const { client, calls } = makeClient([new Error('ECONNRESET')], { maxAttempts: 3 });

    await expect(client.get('/game/')).rejects.toMatchObject({ category: 'network' });
    expect(calls).toHaveLength(3);
  });

  it('успех после временного сбоя', async () => {
    const { client } = makeClient([new Error('ETIMEDOUT'), htmlResponse('<html>ok</html>')]);

    const result = await client.get('/game/');
    expect(result.status).toBe(200);
  });
});

describe('Некорректный ответ', () => {
  it('пустое тело при 200 — ошибка, а не пустой успех', async () => {
    const { client } = makeClient([htmlResponse('   ')]);

    await expect(client.get('/game/')).rejects.toMatchObject({
      category: 'parse_error',
    });
  });
});

describe('Отмена операции', () => {
  it('прерывает запрос по сигналу', async () => {
    const controller = new AbortController();
    controller.abort();

    const { client, calls } = makeClient([htmlResponse()]);

    await expect(client.get('/game/', controller.signal)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('ошибка отмены имеет категорию aborted', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const { client } = makeClient([abortError]);

    const error = await client.get('/game/').catch((e: unknown) => e);
    expect((error as IngestionError).category).toBe('aborted');
  });
});

describe('parseRetryAfter', () => {
  it('разбирает значение в секундах', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('разбирает HTTP-дату', () => {
    const now = new Date('2026-09-07T10:00:00Z').getTime();
    const future = new Date('2026-09-07T10:00:30Z').toUTCString();
    expect(parseRetryAfter(future, () => now)).toBe(30_000);
  });

  it('прошедшая дата даёт 0', () => {
    const now = new Date('2026-09-07T10:00:00Z').getTime();
    const past = new Date('2026-09-07T09:59:00Z').toUTCString();
    expect(parseRetryAfter(past, () => now)).toBe(0);
  });

  it('возвращает undefined для мусора и отсутствия заголовка', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('не-дата')).toBeUndefined();
  });
});

describe('Ограничение скорости', () => {
  it('token bucket выдерживает заданный темп', async () => {
    let now = 0;
    const waits: number[] = [];

    const limiter = new TokenBucketRateLimiter({
      requestsPerSecond: 1,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });

    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    // Первый запрос проходит сразу, дальше — по одному в секунду
    expect(waits).toEqual([1000, 1000]);
  });

  it('лимитер общий: параллельные вызовы не обходят ограничение', async () => {
    let now = 0;
    let waited = 0;

    const limiter = new TokenBucketRateLimiter({
      requestsPerSecond: 1,
      now: () => now,
      sleep: async (ms) => {
        waited += ms;
        now += ms;
      },
    });

    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);

    // Три запроса при 1 req/s требуют минимум 2 секунды ожидания
    expect(waited).toBeGreaterThanOrEqual(2000);
  });

  it('отменяется по сигналу', async () => {
    const controller = new AbortController();
    controller.abort();

    const limiter = new TokenBucketRateLimiter({ requestsPerSecond: 1 });
    await expect(limiter.acquire(controller.signal)).rejects.toThrow(/отменена/);
  });
});

describe('Логирование запросов', () => {
  let lines: string[];

  beforeEach(() => {
    lines = [];
  });

  it('не пишет полный HTML — только размер', async () => {
    const bigHtml = `<html>${'x'.repeat(5000)}</html>`;
    const logger = new StructuredLogger({ sink: (line) => lines.push(line) });
    const { client } = makeClient([htmlResponse(bigHtml)], { logger });

    await client.get('/game/');

    const joined = lines.join('\n');
    expect(joined).toContain('responseBytes');
    expect(joined).not.toContain('x'.repeat(600));
  });

  it('фиксирует URL, статус, длительность и число попыток', async () => {
    const logger = new StructuredLogger({ sink: (line) => lines.push(line) });
    const { client } = makeClient([htmlResponse()], { logger });

    await client.get('/game/');

    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry.source).toBe('metacritic');
    expect(entry.operation).toBe('http_get');
    expect(entry.status).toBe(200);
    expect(entry.url).toContain('/game/');
    expect(typeof entry.durationMs).toBe('number');
    expect(entry.attempts).toBe(1);
  });

  it('фиксирует категорию ошибки', async () => {
    const logger = new StructuredLogger({ sink: (line) => lines.push(line) });
    const { client } = makeClient([new Response('no', { status: 403 })], { logger });

    await client.get('/game/').catch(() => undefined);

    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry.errorCategory).toBe('blocked');
    expect(entry.retryable).toBe(false);
  });
});
