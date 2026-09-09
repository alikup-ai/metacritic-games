import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '../../shared/logging/logger.js';
import { ApiError, toApiError, toErrorBody } from './errors.js';

/**
 * Минимальный маршрутизатор.
 *
 * Ровно то, что нужно текущему API: метод, путь с параметрами, разбор
 * строки запроса, тело JSON, requestId и отображение ошибок. Ни системы
 * подключаемых модулей, ни цепочек обработчиков — они здесь не нужны
 * и только усложнили бы проверку.
 */

export interface RequestContext {
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Тело запроса; читается только там, где оно ожидается. */
  readonly readJsonBody: () => Promise<unknown>;
}

export interface HandlerResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

export type Handler = (context: RequestContext) => Promise<HandlerResult>;

interface Route {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handler: Handler;
}

const MAX_BODY_BYTES = 64 * 1024;

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split('/').filter((s) => s.length > 0),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler);
  }

  /**
   * Находит обработчик.
   *
   * Различает «пути нет» и «метод не тот»: во втором случае корректен 405,
   * а не 404.
   */
  match(
    method: string,
    path: string,
  ): { handler: Handler; params: Record<string, string> } | 'method_not_allowed' | null {
    const segments = path.split('/').filter((s) => s.length > 0);
    let pathExists = false;

    for (const route of this.routes) {
      if (route.segments.length !== segments.length) continue;

      const params: Record<string, string> = {};
      let matched = true;

      for (let i = 0; i < route.segments.length; i += 1) {
        const expected = route.segments[i]!;
        const actual = segments[i]!;

        if (expected.startsWith(':')) {
          params[expected.slice(1)] = decodeURIComponent(actual);
        } else if (expected !== actual) {
          matched = false;
          break;
        }
      }

      if (!matched) continue;

      pathExists = true;
      if (route.method === method.toUpperCase()) {
        return { handler: route.handler, params };
      }
    }

    return pathExists ? 'method_not_allowed' : null;
  }
}

/** Читает тело запроса с ограничением размера. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new ApiError('VALIDATION_ERROR', 'Тело запроса слишком велико');
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

function buildContext(
  request: IncomingMessage,
  params: Record<string, string>,
  requestId: string,
): RequestContext {
  const url = new URL(request.url ?? '/', 'http://localhost');

  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    // При повторе параметра берётся первое значение: массив там,
    // где ожидается строка, — источник неожиданного поведения.
    if (!(key in query)) query[key] = value;
  }

  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }

  return {
    requestId,
    method: (request.method ?? 'GET').toUpperCase(),
    path: url.pathname,
    params,
    query,
    headers,
    readJsonBody: async () => {
      const raw = await readBody(request);
      if (raw.trim().length === 0) return {};
      try {
        return JSON.parse(raw);
      } catch {
        throw new ApiError('VALIDATION_ERROR', 'Тело запроса не является корректным JSON');
      }
    },
  };
}

export interface HandleOptions {
  readonly router: Router;
  readonly logger: Logger;
}

/**
 * Обрабатывает один запрос.
 *
 * Единственное место, где ошибка превращается в ответ: подробности
 * остаются в логе, наружу уходит стабильный код.
 */
export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: HandleOptions,
): Promise<void> {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const url = new URL(request.url ?? '/', 'http://localhost');
  const method = (request.method ?? 'GET').toUpperCase();

  const send = (status: number, body: unknown, headers?: Record<string, string>): void => {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'x-request-id': requestId,
      ...headers,
    });
    response.end(payload);
  };

  try {
    const matched = options.router.match(method, url.pathname);

    if (matched === null) {
      throw new ApiError('NOT_FOUND', 'Ресурс не найден');
    }

    if (matched === 'method_not_allowed') {
      // 405 не входит в перечень §8, но подменять его на 404 было бы
      // неверно: путь существует.
      send(405, {
        error: { code: 'NOT_FOUND', message: 'Метод не поддерживается', requestId },
      });
      return;
    }

    const context = buildContext(request, matched.params, requestId);
    const result = await matched.handler(context);

    options.logger.info('Запрос обработан', {
      operation: 'api_request',
      requestId,
      method,
      // Путь без строки запроса: в ней бывают пользовательские значения.
      path: url.pathname,
      status: result.status,
      durationMs: Date.now() - startedAt,
    });

    send(result.status, result.body, result.headers);
  } catch (error) {
    const apiError = toApiError(error);

    // Внутренние сбои логируются целиком — но только в лог, не в ответ.
    if (apiError.status >= 500) {
      options.logger.error('Ошибка обработки запроса', {
        operation: 'api_request',
        requestId,
        method,
        path: url.pathname,
        status: apiError.status,
        code: apiError.code,
        errorMessage:
          apiError.cause instanceof Error ? apiError.cause.message : String(apiError.cause),
      });
    } else {
      options.logger.warn('Запрос отклонён', {
        operation: 'api_request',
        requestId,
        method,
        path: url.pathname,
        status: apiError.status,
        code: apiError.code,
      });
    }

    send(
      apiError.status,
      toErrorBody(apiError, requestId),
      apiError.retryAfterSeconds !== undefined
        ? { 'retry-after': String(apiError.retryAfterSeconds) }
        : undefined,
    );
  }
}
