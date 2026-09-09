import 'server-only';

import type {
  GameAnalysis,
  GameDetail,
  GameListItem,
  Paged,
  PlatformOption,
  RunDetail,
  RunListItem,
  RunTriggerResult,
  SortField,
  SortOrder,
  VideoInsight,
  WorkerStatus,
} from './types.js';

/**
 * Клиент API. Выполняется ТОЛЬКО на сервере.
 *
 * Импорт 'server-only' превращает случайное использование в клиентском
 * компоненте в ошибку сборки: адрес бэкенда и заголовки не должны попадать
 * в браузерный пакет.
 *
 * Все обращения к бэкенду проходят здесь: fetch по компонентам не
 * разбрасывается.
 */

/** Адрес бэкенда. Только серверная переменная — без префикса NEXT_PUBLIC_. */
function baseUrl(): string {
  return process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';
}

const DEFAULT_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS ?? 8000);

/** Сбой обращения к API, приведённый к виду, пригодному для интерфейса. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** Ресурс отсутствует — интерфейс показывает страницу «не найдено». */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

interface RequestOptions {
  /**
   * Время жизни кеша в секундах.
   *
   * Данные меняются после обхода источника и анализа, поэтому кеш
   * недолгий и задаётся явно для каждого запроса. Бесконтрольное
   * кеширование показывало бы устаревшие оценки.
   */
  readonly revalidate: number;
}

async function request<T>(
  path: string,
  options: RequestOptions,
): Promise<T> {
  const url = `${baseUrl()}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      next: { revalidate: options.revalidate },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch {
    // Сетевой сбой или таймаут. Исходную ошибку наружу не передаём:
    // её текст содержит адрес бэкенда, который клиенту знать незачем.
    throw new ApiRequestError(503, 'NETWORK_ERROR', 'Сервис временно недоступен', null);
  }

  if (!response.ok) {
    // Тело ошибки уже безопасно: бэкенд не кладёт туда ни трассировку,
    // ни секреты (docs/API.md §2).
    let code = 'HTTP_ERROR';
    let message = 'Не удалось получить данные';
    let requestId: string | null = response.headers.get('x-request-id');

    try {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string; requestId?: string };
      };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
      if (body.error?.requestId) requestId = body.error.requestId;
    } catch {
      // Ответ без JSON-тела — оставляем общие значения.
    }

    throw new ApiRequestError(response.status, code, message, requestId);
  }

  return (await response.json()) as T;
}

export interface GameListParams {
  readonly page?: number;
  readonly pageSize?: number;
  readonly q?: string;
  readonly platform?: string;
  readonly sort?: SortField;
  readonly order?: SortOrder;
}

/** Собирает строку запроса, пропуская пустые значения. */
function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export async function fetchGames(
  params: GameListParams = {},
): Promise<Paged<GameListItem>> {
  const query = buildQuery({
    page: params.page,
    pageSize: params.pageSize,
    q: params.q,
    platform: params.platform,
    sort: params.sort,
    order: params.order,
  });

  // Каталог обновляется после ежечасного обхода: минуты достаточно,
  // чтобы снять нагрузку и не показывать заметно устаревшие данные.
  return request<Paged<GameListItem>>(`/api/games${query}`, { revalidate: 60 });
}

export async function fetchGame(id: string): Promise<GameDetail> {
  return request<GameDetail>(`/api/games/${encodeURIComponent(id)}`, {
    revalidate: 60,
  });
}

export async function fetchAnalysis(id: string): Promise<GameAnalysis> {
  // Анализ меняется реже каталога, но привязан к той же карточке.
  return request<GameAnalysis>(`/api/games/${encodeURIComponent(id)}/analysis`, {
    revalidate: 300,
  });
}

export async function fetchPlatforms(): Promise<{ items: readonly PlatformOption[] }> {
  // Список платформ практически статичен.
  return request<{ items: readonly PlatformOption[] }>('/api/platforms', {
    revalidate: 3600,
  });
}

// ============================================================================
// Мониторинг
// ============================================================================

/**
 * Состояние обработчиков и запуски.
 *
 * Кеш отключён (revalidate: 0): мониторинг обязан показывать текущее
 * положение дел, а не состояние минутной давности.
 */
export async function fetchWorkers(): Promise<{ items: readonly WorkerStatus[] }> {
  return request<{ items: readonly WorkerStatus[] }>('/api/monitoring/workers', {
    revalidate: 0,
  });
}

export async function fetchRuns(limit = 20): Promise<{ items: readonly RunListItem[] }> {
  return request<{ items: readonly RunListItem[] }>(`/api/runs?limit=${limit}`, {
    revalidate: 0,
  });
}

export async function fetchRun(id: string): Promise<RunDetail> {
  return request<RunDetail>(`/api/runs/${encodeURIComponent(id)}`, { revalidate: 0 });
}

/**
 * Ручной запуск обработки.
 *
 * Токен берётся из серверного окружения и в браузер не передаётся:
 * запрос выполняется на сервере Next.
 *
 * 409 (запуск уже идёт) — это не сбой, а состояние: возвращается вместе
 * с телом ответа, чтобы интерфейс объяснил причину.
 */
export async function triggerRun(): Promise<{
  status: number;
  result: RunTriggerResult | null;
  message: string | null;
}> {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    return { status: 503, result: null, message: 'Ручной запуск не настроен на сервере' };
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/api/runs`, {
      method: 'POST',
      headers: { 'x-admin-token': token, accept: 'application/json' },
      cache: 'no-store',
      // Отдельный тайм-аут: обработка 20 игр занимает 67–71 с на реальных
      // данных. При 30 с ожидание обрывалось на успешном запуске, и
      // интерфейс сообщал о недоступности сервиса. Общий тайм-аут
      // остальных запросов не меняется.
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    return { status: 503, result: null, message: 'Сервис обработки недоступен' };
  }

  const body: unknown = await response.json().catch(() => null);

  if (response.status === 202 || response.status === 409) {
    return { status: response.status, result: body as RunTriggerResult, message: null };
  }

  const error = body as { error?: { message?: string } } | null;
  return {
    status: response.status,
    result: null,
    // Сообщение бэкенда безопасно: секретов и трассировки в нём нет
    message: error?.error?.message ?? 'Не удалось запустить обработку',
  };
}

/**
 * Обогащение видеообзором.
 *
 * Кеш короткий: результат меняется только после ручного запуска.
 */
export async function fetchVideoInsight(gameId: string): Promise<VideoInsight> {
  return request<VideoInsight>(`/api/games/${encodeURIComponent(gameId)}/video`, {
    revalidate: 60,
  });
}
