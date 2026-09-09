import { describe, expect, it, vi } from 'vitest';
import { OpenRouterLlmProvider } from '../../src/modules/analysis/infrastructure/openrouter-llm-provider.js';
import {
  LlmError,
  type LlmAnalysisRequest,
} from '../../src/modules/analysis/domain/llm-provider.js';

/**
 * Контрактные тесты адаптера OpenRouter.
 *
 * Реальный API НЕ вызывается: fetch подменяется. Ключ фиктивный и никуда
 * не уходит — сети нет вовсе.
 */

const FAKE_KEY = 'test-key-not-real';
const ENDPOINT = 'https://openrouter.test/api/v1/chat/completions';

const request: LlmAnalysisRequest = {
  kind: 'user',
  gameTitle: 'Тестовая игра',
  platformSlug: 'pc',
  reviews: [
    {
      ref: 'r1',
      reviewKey: 'user:u1',
      score: 9,
      date: '2026-01-01',
      text: 'Отличная игра',
      truncated: false,
      duplicates: 1,
      source: 'user',
    },
    {
      ref: 'r2',
      reviewKey: 'user:u2',
      score: 2,
      date: '2026-01-02',
      text: 'Много багов',
      truncated: false,
      duplicates: 1,
      source: 'user',
    },
  ],
  analyzedCount: 2,
  totalAvailable: 2,
  promptVersion: 'v1',
  samplingVersion: 'v1',
  maxOutputTokens: 1500,
};

const validOutput = {
  summary: 'Мнения разделились: одни хвалят игру, другие жалуются на баги.',
  liked: [{ text: 'Атмосфера', evidenceRefs: ['r1'] }],
  disliked: [{ text: 'Баги', evidenceRefs: ['r2'] }],
  themes: [
    {
      name: 'стабильность',
      sentiment: 'negative',
      description: 'Технические проблемы',
      evidenceRefs: ['r2'],
    },
  ],
  confidence: 'medium',
};

/** Ответ шлюза в его фактическом формате. */
function gatewayResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    model: 'configured/model-a',
    choices: [
      {
        finish_reason: 'stop',
        message: { role: 'assistant', content: JSON.stringify(validOutput) },
      },
    ],
    usage: { prompt_tokens: 500, completion_tokens: 120, total_tokens: 620 },
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function makeProvider(
  fetchImpl: typeof fetch,
  options: Record<string, unknown> = {},
): OpenRouterLlmProvider {
  return new OpenRouterLlmProvider({
    apiKey: FAKE_KEY,
    model: 'configured/model-a',
    timeoutMs: 5000,
    maxOutputTokens: 1500,
    endpoint: ENDPOINT,
    fetchImpl,
    ...options,
  });
}

const okFetch = (): typeof fetch =>
  vi.fn(async () => jsonResponse(gatewayResponse())) as unknown as typeof fetch;

describe('Создание провайдера', () => {
  it('без ключа провайдер не создаётся', () => {
    expect(() =>
      makeProvider(okFetch(), { apiKey: '' }),
    ).toThrow(/LLM_API_KEY/);
  });

  it('пробельный ключ отклоняется', () => {
    expect(() => makeProvider(okFetch(), { apiKey: '   ' })).toThrow();
  });
});

describe('Контракт: запрос → шлюз → нормализованный результат', () => {
  it('ответ шлюза приводится к результату порта', async () => {
    const result = await makeProvider(okFetch()).analyzeReviews(request);

    expect(result.content.summary).toBe(validOutput.summary);
    expect(result.content.liked[0]?.text).toBe('Атмосфера');
    expect(result.content.confidence).toBe('medium');
    expect(result.model).toBe('configured/model-a');
    expect(result.usage.inputTokens).toBe(500);
    expect(result.usage.outputTokens).toBe(120);
  });

  it('обращение идёт на endpoint OpenRouter', async () => {
    const fetchImpl = okFetch();
    await makeProvider(fetchImpl).analyzeReviews(request);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe(ENDPOINT);
    expect((init as RequestInit).method).toBe('POST');
  });

  it('модель берётся из конфигурации, а не зашита в код', async () => {
    const fetchImpl = okFetch();
    await makeProvider(fetchImpl, { model: 'другой/поставщик-модель' }).analyzeReviews(
      request,
    );

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as { model: string };
    expect(body.model).toBe('другой/поставщик-модель');
  });

  it('фактическая модель берётся из ответа: шлюз мог перенаправить запрос', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(gatewayResponse({ model: 'fallback/model-b' })),
    ) as unknown as typeof fetch;

    const result = await makeProvider(fetchImpl).analyzeReviews(request);
    expect(result.model).toBe('fallback/model-b');
  });

  it('отсутствие usage даёт null, а не выдуманное число', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(gatewayResponse({ usage: undefined })),
    ) as unknown as typeof fetch;

    const result = await makeProvider(fetchImpl).analyzeReviews(request);
    expect(result.usage.inputTokens).toBeNull();
    expect(result.usage.outputTokens).toBeNull();
  });
});

describe('Формирование запроса', () => {
  it('структурированный вывод задаётся через response_format', async () => {
    const fetchImpl = okFetch();
    await makeProvider(fetchImpl).analyzeReviews(request);

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as {
      response_format: {
        type: string;
        json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
      };
      max_tokens: number;
    };

    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.max_tokens).toBe(1500);

    // Схема выведена из нашей zod-схемы, а не написана вручную
    const schema = body.response_format.json_schema.schema;
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties as object)).toEqual(
      expect.arrayContaining(['summary', 'liked', 'disliked', 'themes', 'confidence']),
    );
  });

  it('инструкции и данные разделены по ролям', async () => {
    const fetchImpl = okFetch();
    await makeProvider(fetchImpl).analyzeReviews(request);

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as {
      messages: { role: string; content: string }[];
    };

    expect(body.messages[0]!.role).toBe('system');
    expect(body.messages[0]!.content).not.toContain('Отличная игра');

    // Отзывы уходят как JSON-данные в пользовательском сообщении
    const payload = JSON.parse(body.messages[1]!.content) as {
      reviews: { ref: string; text: string }[];
    };
    expect(payload.reviews.map((r) => r.ref)).toEqual(['r1', 'r2']);
  });

  it('ключ уходит только в заголовке Authorization', async () => {
    const fetchImpl = okFetch();
    await makeProvider(fetchImpl).analyzeReviews(request);

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;

    expect(headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    // В теле запроса ключа быть не должно
    expect((init as RequestInit).body as string).not.toContain(FAKE_KEY);
  });

  it('заголовки атрибуции необязательны', async () => {
    const fetchImpl = okFetch();
    await makeProvider(fetchImpl, {
      appUrl: 'https://example.test',
      appTitle: 'Metacritic Games',
    }).analyzeReviews(request);

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;

    expect(headers['HTTP-Referer']).toBe('https://example.test');
    expect(headers['X-Title']).toBe('Metacritic Games');
  });
});

describe('Проверка ответа', () => {
  it('ответ проверяется нашей схемой: строгий режим не гарантирован', async () => {
    // Шлюз вернул структурно неверный ответ, несмотря на strict: true
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        gatewayResponse({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: JSON.stringify({ summary: 'слишком мало полей' }) },
            },
          ],
        }),
      ),
    ) as unknown as typeof fetch;

    await expect(makeProvider(fetchImpl).analyzeReviews(request)).rejects.toMatchObject({
      category: 'schema_invalid',
    });
  });

  it('невалидный JSON в содержимом даёт malformed_json', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        gatewayResponse({
          choices: [{ finish_reason: 'stop', message: { content: '{ сломанный' } }],
        }),
      ),
    ) as unknown as typeof fetch;

    await expect(makeProvider(fetchImpl).analyzeReviews(request)).rejects.toMatchObject({
      category: 'malformed_json',
    });
  });

  it('ссылка на несуществующий отзыв даёт evidence_invalid', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        gatewayResponse({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  ...validOutput,
                  liked: [{ text: 'Нечто', evidenceRefs: ['r404'] }],
                }),
              },
            },
          ],
        }),
      ),
    ) as unknown as typeof fetch;

    await expect(makeProvider(fetchImpl).analyzeReviews(request)).rejects.toMatchObject({
      category: 'evidence_invalid',
    });
  });

  it('finish_reason length даёт token_limit и НЕ повторяется', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        gatewayResponse({
          choices: [{ finish_reason: 'length', message: { content: '{"summary"' } }],
        }),
      ),
    ) as unknown as typeof fetch;

    const error = await makeProvider(fetchImpl)
      .analyzeReviews(request)
      .catch((e: LlmError) => e);

    expect((error as LlmError).category).toBe('token_limit');
    expect((error as LlmError).retryable).toBe(false);
  });

  it('пустое содержимое не принимается за успех', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        gatewayResponse({
          choices: [{ finish_reason: 'stop', message: { content: '' } }],
        }),
      ),
    ) as unknown as typeof fetch;

    await expect(makeProvider(fetchImpl).analyzeReviews(request)).rejects.toBeInstanceOf(
      LlmError,
    );
  });

  it('ответ без вариантов не принимается за успех', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(gatewayResponse({ choices: [] })),
    ) as unknown as typeof fetch;

    await expect(makeProvider(fetchImpl).analyzeReviews(request)).rejects.toBeInstanceOf(
      LlmError,
    );
  });
});

describe('Ошибки внутри ответа 200', () => {
  it('ошибка в choices[].error распознаётся, несмотря на код 200', async () => {
    // Заголовки уходят до сбоя у поставщика — статус остаётся 200
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            error: {
              code: 503,
              message: 'provider is overloaded',
              metadata: { error_type: 'provider_overloaded' },
            },
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const error = await makeProvider(fetchImpl)
      .analyzeReviews(request)
      .catch((e: LlmError) => e);

    expect((error as LlmError).category).toBe('unavailable');
    expect((error as LlmError).retryable).toBe(true);
  });

  it('ошибка верхнего уровня при 200 распознаётся', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        error: {
          code: 429,
          message: 'rate limited',
          metadata: { error_type: 'rate_limit_exceeded' },
        },
      }),
    ) as unknown as typeof fetch;

    await expect(makeProvider(fetchImpl).analyzeReviews(request)).rejects.toMatchObject({
      category: 'rate_limited',
    });
  });

  it('исчерпание контекста при 200 не превращается в повторы', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        error: {
          code: 400,
          message: 'context length exceeded',
          metadata: { error_type: 'context_length_exceeded' },
        },
      }),
    ) as unknown as typeof fetch;

    const error = await makeProvider(fetchImpl)
      .analyzeReviews(request)
      .catch((e: LlmError) => e);

    expect((error as LlmError).category).toBe('token_limit');
    expect((error as LlmError).retryable).toBe(false);
  });
});

describe('Классификация ошибок HTTP', () => {
  const call = async (status: number, headers: Record<string, string> = {}) => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'boom' } }, { status, headers }),
    ) as unknown as typeof fetch;

    return makeProvider(fetchImpl)
      .analyzeReviews(request)
      .catch((e: LlmError) => e) as Promise<LlmError>;
  };

  it('429 → rate_limited и повторяется', async () => {
    const error = await call(429);
    expect(error.category).toBe('rate_limited');
    expect(error.retryable).toBe(true);
  });

  it('429 переносит Retry-After в задержку', async () => {
    const error = await call(429, { 'retry-after': '7' });
    expect(error.retryAfterMs).toBe(7000);
  });

  it('502 и 503 → unavailable и повторяются', async () => {
    for (const status of [502, 503]) {
      const error = await call(status);
      expect(error.category).toBe('unavailable');
      expect(error.retryable).toBe(true);
    }
  });

  it('408 и 504 → timeout и повторяются', async () => {
    for (const status of [408, 504]) {
      const error = await call(status);
      expect(error.category).toBe('timeout');
      expect(error.retryable).toBe(true);
    }
  });

  it('500 → server_error и повторяется', async () => {
    const error = await call(500);
    expect(error.category).toBe('server_error');
    expect(error.retryable).toBe(true);
  });

  it('400/401/402/403 → client_error и НЕ повторяются', async () => {
    for (const status of [400, 401, 402, 403]) {
      const error = await call(status);
      expect(error.category).toBe('client_error');
      expect(error.retryable).toBe(false);
    }
  });

  it('некорректный JSON от шлюза даёт malformed_json', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('не json', { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(makeProvider(fetchImpl).analyzeReviews(request)).rejects.toMatchObject({
      category: 'malformed_json',
    });
  });
});

describe('Таймаут и отмена', () => {
  it('превышение таймаута даёт timeout и повторяется', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      // Ждём отмены по нашему таймауту
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }) as unknown as typeof fetch;

    const error = (await makeProvider(fetchImpl, { timeoutMs: 20 })
      .analyzeReviews(request)
      .catch((e: LlmError) => e)) as LlmError;

    expect(error.category).toBe('timeout');
    expect(error.retryable).toBe(true);
  });

  it('внешняя отмена даёт aborted и НЕ повторяется', async () => {
    const controller = new AbortController();

    // Настоящий fetch отклоняет запрос сразу, если сигнал уже отменён
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }) as unknown as typeof fetch;

    controller.abort();

    const error = (await makeProvider(fetchImpl)
      .analyzeReviews({ ...request, signal: controller.signal })
      .catch((e: LlmError) => e)) as LlmError;

    expect(error.category).toBe('aborted');
    expect(error.retryable).toBe(false);
  });

  it('отмена в процессе запроса тоже даёт aborted', async () => {
    const controller = new AbortController();

    const fetchImpl = vi.fn(
      async (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
          // Отмена приходит уже после начала запроса
          setTimeout(() => controller.abort(), 5);
        }),
    ) as unknown as typeof fetch;

    const error = (await makeProvider(fetchImpl)
      .analyzeReviews({ ...request, signal: controller.signal })
      .catch((e: LlmError) => e)) as LlmError;

    expect(error.category).toBe('aborted');
  });

  it('сетевой сбой даёт unavailable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    const error = (await makeProvider(fetchImpl)
      .analyzeReviews(request)
      .catch((e: LlmError) => e)) as LlmError;

    expect(error.category).toBe('unavailable');
  });
});

describe('Утечки секретов и данных', () => {
  it('ключ не попадает в сообщения об ошибках', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'boom' } }, { status: 401 }),
    ) as unknown as typeof fetch;

    const error = (await makeProvider(fetchImpl)
      .analyzeReviews(request)
      .catch((e: LlmError) => e)) as LlmError;

    expect(error.message).not.toContain(FAKE_KEY);
  });

  it('в лог не попадают ключ, тексты отзывов и ответ модели', async () => {
    const entries: { message: string; context?: unknown }[] = [];
    const logger = {
      info: (message: string, context?: unknown) => entries.push({ message, context }),
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    };

    await makeProvider(okFetch(), { logger }).analyzeReviews(request);

    const logged = JSON.stringify(entries);
    expect(logged).not.toContain(FAKE_KEY);
    expect(logged).not.toContain('Отличная игра');
    expect(logged).not.toContain(validOutput.summary);
    // Счётчики при этом фиксируются
    expect(logged).toContain('inputCount');
  });
});
