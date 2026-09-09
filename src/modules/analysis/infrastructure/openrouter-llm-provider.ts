import { z } from 'zod/v4';
import { silentLogger, type Logger } from '../../../shared/logging/logger.js';
import { parseRetryAfter } from '../../../shared/http/retry-after.js';
import {
  LlmError,
  type LlmAnalysisRequest,
  type LlmAnalysisResult,
  type LlmProvider,
} from '../domain/llm-provider.js';
import {
  analysisOutputSchema,
  parseAnalysisOutput,
  toAnalysisContent,
  validateEvidence,
} from '../application/validate-output.js';
import { buildSystemPrompt, buildUserPrompt } from './prompts.js';

/**
 * Провайдер OpenRouter — единый шлюз к моделям.
 *
 * Единственное место, где проект знает про конкретного поставщика:
 * application работает через порт LlmProvider (ADR-0006). Смена шлюза
 * или модели не затрагивает ни domain, ни application.
 *
 * Модель НЕ зашита в код: приходит из конфигурации (LLM_MODEL).
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/** Имя схемы в запросе; на разбор ответа не влияет. */
const SCHEMA_NAME = 'review_analysis';

export interface OpenRouterLlmProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly logger?: Logger;
  /** Подменяется в тестах: реальный сетевой вызов не выполняется. */
  readonly fetchImpl?: typeof fetch;
  /** Переопределяется только в тестах. */
  readonly endpoint?: string;
  /**
   * Необязательные заголовки атрибуции OpenRouter (HTTP-Referer, X-Title).
   * Секретов не содержат.
   */
  readonly appUrl?: string;
  readonly appTitle?: string;
}

/**
 * Ответ шлюза. Разбирается мягко: неизвестные поля игнорируются, потому
 * что состав ответа зависит от нижележащего поставщика модели.
 */
const usageSchema = z
  .object({
    prompt_tokens: z.number().nullish(),
    completion_tokens: z.number().nullish(),
  })
  .loose();

const errorPayloadSchema = z
  .object({
    code: z.union([z.number(), z.string()]).nullish(),
    message: z.string().nullish(),
    metadata: z.object({ error_type: z.string().nullish() }).loose().nullish(),
  })
  .loose();

const responseSchema = z
  .object({
    model: z.string().nullish(),
    choices: z
      .array(
        z
          .object({
            finish_reason: z.string().nullish(),
            native_finish_reason: z.string().nullish(),
            message: z.object({ content: z.string().nullish() }).loose().nullish(),
            error: errorPayloadSchema.nullish(),
          })
          .loose(),
      )
      .nullish(),
    usage: usageSchema.nullish(),
    error: errorPayloadSchema.nullish(),
  })
  .loose();

export class OpenRouterLlmProvider implements LlmProvider {
  readonly model: string;

  private readonly apiKey: string;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;

  constructor(private readonly options: OpenRouterLlmProviderOptions) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      // Ключ обязателен и приходит только из окружения: в коде его нет.
      throw new Error('LLM_API_KEY не задан: провайдер не может быть создан');
    }

    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.logger = options.logger ?? silentLogger;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = options.endpoint ?? ENDPOINT;
  }

  async analyzeReviews(request: LlmAnalysisRequest): Promise<LlmAnalysisResult> {
    const startedAt = Date.now();

    // Свой таймаут: повторов на этом уровне нет — политика принадлежит
    // use case, и второй механизм умножал бы задержки.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    const signal = linkSignals(timeout.signal, request.signal);

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(this.buildBody(request)),
        signal,
      });
    } catch (error) {
      throw toNetworkError(error, timeout.signal.aborted, request.signal);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw await toHttpError(response);
    }

    const payload = await this.readBody(response);

    // Ошибка может прийти с кодом 200: заголовки уходят до сбоя у
    // нижележащего поставщика. Проверять только статус недостаточно.
    const inlineError = payload.error ?? payload.choices?.[0]?.error ?? null;
    if (inlineError) throw toInlineError(inlineError);

    const choice = payload.choices?.[0];
    if (!choice) {
      throw new LlmError('unavailable', 'Шлюз вернул ответ без вариантов');
    }

    // Обрыв по лимиту токенов: у OpenRouter это нормализованное 'length'.
    if (choice.finish_reason === 'length') {
      throw new LlmError(
        'token_limit',
        'Ответ обрезан по лимиту токенов: требуется уменьшить выборку',
      );
    }

    const content = choice.message?.content;
    if (!content || content.trim().length === 0) {
      throw new LlmError('schema_invalid', 'Шлюз вернул пустой ответ модели');
    }

    // Ответ проверяется НАШЕЙ схемой, а не принимается на веру: строгий
    // режим OpenRouter не гарантирован — часть поставщиков трактует схему
    // лишь как настойчивую подсказку.
    const parsed = parseAnalysisOutput(content);
    validateEvidence(parsed, request.reviews);

    const usage = {
      inputTokens: payload.usage?.prompt_tokens ?? null,
      outputTokens: payload.usage?.completion_tokens ?? null,
    };

    this.logger.info('Анализ отзывов выполнен', {
      operation: 'llm_analyze',
      kind: request.kind,
      model: payload.model ?? this.model,
      inputCount: request.reviews.length,
      durationMs: Date.now() - startedAt,
      // Ни ключ, ни промпт, ни ответ, ни тексты отзывов в лог не попадают
      tokensIn: usage.inputTokens,
      tokensOut: usage.outputTokens,
    });

    return {
      content: toAnalysisContent(parsed),
      // Фактическая модель из ответа: шлюз мог перенаправить запрос.
      model: payload.model ?? this.model,
      usage,
    };
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      // Единственное место, где ключ покидает конфигурацию.
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    // Необязательная атрибуция OpenRouter; секретов не несёт.
    if (this.options.appUrl) headers['HTTP-Referer'] = this.options.appUrl;
    if (this.options.appTitle) headers['X-Title'] = this.options.appTitle;

    return headers;
  }

  private buildBody(request: LlmAnalysisRequest): Record<string, unknown> {
    return {
      model: this.model,
      max_tokens: request.maxOutputTokens,
      messages: [
        { role: 'system', content: buildSystemPrompt(request.kind) },
        // Отзывы уходят как JSON-данные, а не как инструкции.
        { role: 'user', content: buildUserPrompt(request) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: SCHEMA_NAME,
          strict: true,
          // Схема выводится из той же zod-схемы, которой проверяется
          // ответ: ручная копия разошлась бы незаметно.
          schema: z.toJSONSchema(analysisOutputSchema, { target: 'draft-7' }),
        },
      },
    };
  }

  private async readBody(response: Response): Promise<z.infer<typeof responseSchema>> {
    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error) {
      throw new LlmError('malformed_json', 'Шлюз вернул некорректный JSON', {
        cause: error,
      });
    }

    const result = responseSchema.safeParse(raw);
    if (!result.success) {
      // В сообщение попадают пути и коды, но не содержимое ответа.
      const issues = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
        .join('; ');
      throw new LlmError('schema_invalid', `Неожиданная форма ответа шлюза: ${issues}`);
    }

    return result.data;
  }
}

/**
 * Объединяет наш таймаут с внешней отменой.
 *
 * AbortSignal.any доступен не везде, поэтому есть запасной путь.
 */
function linkSignals(own: AbortSignal, external?: AbortSignal): AbortSignal {
  if (!external) return own;

  const any = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === 'function') return any([own, external]);

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (external.aborted || own.aborted) controller.abort();
  own.addEventListener('abort', abort, { once: true });
  external.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

/** Различает наш таймаут и отмену вызывающим. */
function toNetworkError(
  error: unknown,
  timedOut: boolean,
  externalSignal?: AbortSignal,
): LlmError {
  if (externalSignal?.aborted) {
    return new LlmError('aborted', 'Запрос к модели отменён', { cause: error });
  }

  if (timedOut) {
    return new LlmError('timeout', 'Истекло время ожидания ответа модели', {
      cause: error,
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new LlmError('unavailable', `Шлюз недоступен: ${message}`, { cause: error });
}

/**
 * Классифицирует ответ по коду HTTP.
 *
 * Тело читается, но в сообщение не подставляется: там может оказаться
 * эхо запроса.
 */
async function toHttpError(response: Response): Promise<LlmError> {
  const status = response.status;
  await response.text().catch(() => '');

  if (status === 429) {
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    return new LlmError('rate_limited', 'Превышен лимит запросов к шлюзу', {
      ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
    });
  }

  // 502/503 — временная недоступность поставщика модели; 504 — таймаут.
  if (status === 502 || status === 503) {
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    return new LlmError('unavailable', `Поставщик модели недоступен (${status})`, {
      ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
    });
  }

  if (status === 408 || status === 504) {
    return new LlmError('timeout', `Шлюз не ответил вовремя (${status})`);
  }

  if (status >= 500) {
    return new LlmError('server_error', `Ошибка шлюза (${status})`);
  }

  // Прочие 4xx повтором не лечатся: неверный запрос, ключ, права
  // или исчерпанные средства.
  return new LlmError('client_error', `Запрос отклонён шлюзом (${status})`);
}

/** Ошибка внутри ответа с кодом 200. */
function toInlineError(payload: z.infer<typeof errorPayloadSchema>): LlmError {
  const errorType = payload.metadata?.error_type ?? null;
  const code = typeof payload.code === 'number' ? payload.code : null;

  const category = classifyErrorType(errorType, code);
  const detail = errorType ?? (code !== null ? String(code) : 'без кода');

  return new LlmError(category, `Шлюз сообщил об ошибке (${detail})`);
}

/**
 * Сопоставляет типизированные ошибки OpenRouter с нашими категориями.
 *
 * Категория определяет, имеет ли смысл повтор.
 */
export function classifyErrorType(
  errorType: string | null,
  code: number | null,
): LlmError['category'] {
  switch (errorType) {
    case 'rate_limit_exceeded':
      return 'rate_limited';
    case 'provider_overloaded':
    case 'provider_unavailable':
      return 'unavailable';
    case 'timeout':
      return 'timeout';
    case 'server':
    case 'unmapped':
      return 'server_error';
    case 'context_length_exceeded':
    case 'max_tokens_exceeded':
    case 'token_limit_exceeded':
      // Повтор не поможет: нужно уменьшить выборку.
      return 'token_limit';
    default:
      break;
  }

  if (code === 429) return 'rate_limited';
  if (code === 502 || code === 503) return 'unavailable';
  if (code === 408 || code === 504) return 'timeout';
  if (code !== null && code >= 500) return 'server_error';
  if (code !== null && code >= 400) return 'client_error';

  return 'unavailable';
}
