import type { RunRepository } from '../../modules/monitoring/domain/run.js';
import type { ClaimRepository } from '../../modules/ingestion/domain/claim-repository.js';
import type { RunDailyProcessingUseCase } from '../../modules/ingestion/application/run-daily-processing.js';
import {
  toRunDetailDto,
  toRunListItemDto,
  toWorkerStatusDto,
  type RunDetailDto,
  type RunListItemDto,
  type RunTriggerResultDto,
  type WorkerStatusDto,
} from '../dto/index.js';
import { ADMIN_TOKEN_HEADER, requireAdminToken } from '../http/auth.js';
import { ApiError } from '../http/errors.js';
import type { RateLimiter } from '../http/rate-limit.js';
import type { Handler } from '../http/router.js';
import { parseLimit, parseUuid } from '../http/validation.js';

/**
 * Маршруты запусков и мониторинга.
 *
 * Ручной запуск переиспользует существующий вариант использования: своей
 * логики планирования здесь нет. Идемпотентность и защита от параллельного
 * запуска обеспечиваются реестром заявок и блокировкой, а не этим слоем.
 */

export interface MonitoringDeps {
  readonly runs: RunRepository;
  readonly claims: ClaimRepository;
  /** null, если обработка не собрана (например, при выключенной конфигурации). */
  readonly runDailyProcessing: RunDailyProcessingUseCase | null;
  readonly adminToken: string | undefined;
  readonly rateLimiter: RateLimiter;
  readonly runListDefaults: { defaultLimit: number; maxLimit: number };
}

/** Ключ ограничения частоты. */
function clientKey(context: { headers: Readonly<Record<string, string | undefined>> }): string {
  // За обратным прокси реальный адрес приходит заголовком. Значение
  // подделывается клиентом, поэтому это ограничение от случайного
  // перебора, а не защита от намеренной распределённой нагрузки.
  const forwarded = context.headers['x-forwarded-for'];
  return forwarded?.split(',')[0]?.trim() ?? 'unknown';
}

export function createTriggerRunHandler(deps: MonitoringDeps): Handler {
  return async (context) => {
    // Частота проверяется ДО сравнения токена: иначе endpoint остался бы
    // площадкой для перебора.
    const decision = deps.rateLimiter.check(clientKey(context));
    if (!decision.allowed) {
      throw new ApiError('RATE_LIMITED', 'Слишком много запросов', {
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }

    requireAdminToken({
      headerValue: context.headers[ADMIN_TOKEN_HEADER],
      expectedToken: deps.adminToken,
    });

    if (!deps.runDailyProcessing) {
      throw new ApiError('SERVICE_UNAVAILABLE', 'Обработка недоступна');
    }

    const result = await deps.runDailyProcessing.execute({ trigger: 'manual' });

    const body: RunTriggerResultDto = {
      runId: result.runId,
      outcome: result.outcome,
      processingDay: result.processingDay,
      claimed: result.claimed,
      processed: result.processed,
      failed: result.failed,
      skipped: result.skipped,
      stopReason: result.stopReason,
    };

    // 'skipped' означает, что запуск уже идёт: это конфликт состояния,
    // а не успех и не ошибка сервера.
    const status = result.outcome === 'skipped' ? 409 : 202;
    return { status, body };
  };
}

export function createListRunsHandler(deps: MonitoringDeps): Handler {
  return async (context) => {
    const limit = parseLimit(context.query.limit, deps.runListDefaults);
    const runs = await deps.runs.listRecent(limit);

    const body: { items: readonly RunListItemDto[] } = {
      items: runs.map(toRunListItemDto),
    };

    return { status: 200, body };
  };
}

export function createGetRunHandler(deps: MonitoringDeps): Handler {
  return async (context) => {
    const id = parseUuid(context.params.id, 'id');

    const run = await deps.runs.findById(id);
    if (!run) {
      throw new ApiError('RUN_NOT_FOUND', 'Запуск не найден');
    }

    // Счётчики считаются по заявкам этого запуска: 'partial' выводится
    // из стадий, а не хранится отдельным статусом.
    const counters = await deps.claims.countByRun(run.id);
    const stages = await deps.claims.countStagesByRun(run.id);

    const body: RunDetailDto = toRunDetailDto(run, counters, stages);
    return { status: 200, body };
  };
}

export function createWorkerStatusHandler(deps: MonitoringDeps): Handler {
  return async () => {
    const active = await deps.runs.findActive();

    const body: { items: readonly WorkerStatusDto[] } = {
      items: [toWorkerStatusDto(active)],
    };

    return { status: 200, body };
  };
}

/**
 * Проверка живости.
 *
 * Обращается только к своей базе. Внешние источники (Metacritic,
 * OpenRouter, YouTube) не опрашиваются: их недоступность не означает,
 * что наш сервис нездоров, а опрос сделал бы проверку медленной и платной.
 */
export function createHealthHandler(deps: { ping: () => Promise<void> }): Handler {
  return async () => {
    try {
      await deps.ping();
    } catch (error) {
      throw new ApiError('SERVICE_UNAVAILABLE', 'База данных недоступна', { cause: error });
    }

    return {
      status: 200,
      body: { status: 'ok', timestamp: new Date().toISOString() },
    };
  };
}
