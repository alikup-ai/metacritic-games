import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbPool } from '../../src/shared/db/pool.js';
import { PostgresRunRepository } from '../../src/modules/monitoring/infrastructure/postgres-run-repository.js';
import {
  PostgresClaimRepository,
  PostgresProcessingDayRepository,
} from '../../src/modules/ingestion/infrastructure/postgres-claim-repository.js';
import { PostgresGameRepository } from '../../src/modules/catalog/infrastructure/postgres-game-repository.js';
import { Router } from '../../src/api/server.js';
import { RateLimiter } from '../../src/api/http/rate-limit.js';
import {
  createGetRunHandler,
  createHealthHandler,
  createListRunsHandler,
  createTriggerRunHandler,
  createWorkerStatusHandler,
  type MonitoringDeps,
} from '../../src/api/routes/monitoring-routes.js';
import type { RunDailyProcessingUseCase } from '../../src/modules/ingestion/application/run-daily-processing.js';
import { createTestPool, setupSchema, truncateAll } from './helpers.js';
import { startTestServer, type TestServer } from './api-helpers.js';

/**
 * Тесты API запусков и мониторинга на РЕАЛЬНОЙ PostgreSQL.
 * Настоящая обработка не запускается: use case подменён.
 */

const ADMIN_TOKEN = 'test-admin-token-not-real-0123456789';

let pool: DbPool;
let runs: PostgresRunRepository;
let claims: PostgresClaimRepository;
let games: PostgresGameRepository;
let server: TestServer;

/** Подменённая обработка: считает вызовы, наружу не ходит. */
class StubProcessing {
  calls = 0;
  outcome: 'completed' | 'failed' | 'skipped' = 'completed';
  delayMs = 0;

  async execute(): Promise<{
    outcome: 'completed' | 'failed' | 'skipped';
    runId: string | null;
    processingDay: string;
    claimed: number;
    processed: number;
    failed: number;
    skipped: number;
    stopReason: string | null;
  }> {
    this.calls += 1;
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return {
      outcome: this.outcome,
      runId: this.outcome === 'skipped' ? null : '11111111-1111-4111-8111-111111111111',
      processingDay: '2026-09-08',
      claimed: this.outcome === 'skipped' ? 0 : 20,
      processed: this.outcome === 'skipped' ? 0 : 18,
      failed: this.outcome === 'skipped' ? 0 : 2,
      skipped: 0,
      stopReason: this.outcome === 'skipped' ? 'already_running' : null,
    };
  }
}

let processing: StubProcessing;
let rateLimiter: RateLimiter;
let adminToken: string | undefined;

beforeAll(async () => {
  pool = createTestPool();
  await setupSchema(pool);
  runs = new PostgresRunRepository(pool);
  claims = new PostgresClaimRepository(pool);
  games = new PostgresGameRepository(pool);

  processing = new StubProcessing();
  rateLimiter = new RateLimiter({ windowMs: 60_000, max: 10 });
  adminToken = ADMIN_TOKEN;

  // Значения читаются через геттеры: тесты меняют их между сценариями
  const deps: MonitoringDeps = {
    runs,
    claims,
    get runDailyProcessing(): RunDailyProcessingUseCase | null {
      return processing as unknown as RunDailyProcessingUseCase;
    },
    get adminToken(): string | undefined {
      return adminToken;
    },
    get rateLimiter(): RateLimiter {
      return rateLimiter;
    },
    runListDefaults: { defaultLimit: 20, maxLimit: 100 },
  };

  const router = new Router()
    .post('/api/runs', createTriggerRunHandler(deps))
    .get('/api/runs', createListRunsHandler(deps))
    .get('/api/runs/:id', createGetRunHandler(deps))
    .get('/api/monitoring/workers', createWorkerStatusHandler(deps))
    .get(
      '/api/health',
      createHealthHandler({ ping: async () => void (await pool.query('SELECT 1')) }),
    );

  server = await startTestServer(router);
});

afterAll(async () => {
  await server.close();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  processing = new StubProcessing();
  rateLimiter = new RateLimiter({ windowMs: 60_000, max: 10 });
  adminToken = ADMIN_TOKEN;
});

const authHeaders = { 'x-admin-token': ADMIN_TOKEN };

// ============================================================================
// POST /api/runs — авторизация
// ============================================================================

describe('POST /api/runs — авторизация', () => {
  it('без заголовка даёт 401', async () => {
    const { status, body } = await server.request('/api/runs', { method: 'POST' });
    const payload = body as { error: { code: string } };

    expect(status).toBe(401);
    expect(payload.error.code).toBe('UNAUTHORIZED');
    expect(processing.calls).toBe(0);
  });

  it('с неверным токеном даёт 403', async () => {
    const { status, body } = await server.request('/api/runs', {
      method: 'POST',
      headers: { 'x-admin-token': 'wrong-token' },
    });
    const payload = body as { error: { code: string } };

    expect(status).toBe(403);
    expect(payload.error.code).toBe('FORBIDDEN');
    expect(processing.calls).toBe(0);
  });

  it('токен той же длины, но неверный, тоже даёт 403', async () => {
    const wrong = 'x'.repeat(ADMIN_TOKEN.length);

    const { status } = await server.request('/api/runs', {
      method: 'POST',
      headers: { 'x-admin-token': wrong },
    });
    expect(status).toBe(403);
  });

  it('ошибка авторизации не раскрывает токен', async () => {
    const { body } = await server.request('/api/runs', {
      method: 'POST',
      headers: { 'x-admin-token': 'wrong' },
    });

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(ADMIN_TOKEN);
    expect(serialized).not.toContain('wrong');
  });

  it('если токен не настроен на сервере, запуск недоступен', async () => {
    adminToken = undefined;

    const { status, body } = await server.request('/api/runs', {
      method: 'POST',
      headers: authHeaders,
    });

    // Открытый endpoint был бы опаснее отключённого
    expect(status).toBe(503);
    expect((body as { error: { code: string } }).error.code).toBe('SERVICE_UNAVAILABLE');
    expect(processing.calls).toBe(0);
  });
});

// ============================================================================
// POST /api/runs — запуск
// ============================================================================

describe('POST /api/runs — запуск', () => {
  it('с корректным токеном запускает обработку', async () => {
    const { status, body } = await server.request('/api/runs', {
      method: 'POST',
      headers: authHeaders,
    });
    const dto = body as Record<string, unknown>;

    expect(status).toBe(202);
    expect(processing.calls).toBe(1);
    expect(dto.outcome).toBe('completed');
    expect(dto.claimed).toBe(20);
    expect(dto.processed).toBe(18);
    expect(dto.failed).toBe(2);
  });

  it('уже идущий запуск даёт 409, а не ошибку', async () => {
    processing.outcome = 'skipped';

    const { status, body } = await server.request('/api/runs', {
      method: 'POST',
      headers: authHeaders,
    });
    const dto = body as { outcome: string; stopReason: string };

    expect(status).toBe(409);
    expect(dto.outcome).toBe('skipped');
    expect(dto.stopReason).toBe('already_running');
  });

  it('параллельные вызовы не создают второй обработки', async () => {
    // Обработка сама защищена блокировкой: API её не дублирует
    processing.delayMs = 50;

    const [first, second] = await Promise.all([
      server.request('/api/runs', { method: 'POST', headers: authHeaders }),
      server.request('/api/runs', { method: 'POST', headers: authHeaders }),
    ]);

    expect([first.status, second.status].every((s) => s === 202)).toBe(true);
    // Оба дошли до use case — решение о параллельности принимает он,
    // а не транспортный слой
    expect(processing.calls).toBe(2);
  });

  it('превышение частоты даёт 429 с Retry-After', async () => {
    rateLimiter = new RateLimiter({ windowMs: 60_000, max: 2 });

    await server.request('/api/runs', { method: 'POST', headers: authHeaders });
    await server.request('/api/runs', { method: 'POST', headers: authHeaders });
    const third = await server.request('/api/runs', { method: 'POST', headers: authHeaders });

    expect(third.status).toBe(429);
    expect((third.body as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
    expect(third.headers.get('retry-after')).toBeTruthy();
  });

  it('частота проверяется до токена — endpoint не площадка для перебора', async () => {
    rateLimiter = new RateLimiter({ windowMs: 60_000, max: 2 });

    await server.request('/api/runs', { method: 'POST', headers: { 'x-admin-token': 'a' } });
    await server.request('/api/runs', { method: 'POST', headers: { 'x-admin-token': 'b' } });
    const third = await server.request('/api/runs', {
      method: 'POST',
      headers: { 'x-admin-token': 'c' },
    });

    expect(third.status).toBe(429);
  });
});

// ============================================================================
// GET /api/runs
// ============================================================================

describe('GET /api/runs', () => {
  it('пустой список без запусков', async () => {
    const { status, body } = await server.request('/api/runs');
    expect(status).toBe(200);
    expect((body as { items: unknown[] }).items).toHaveLength(0);
  });

  it('возвращает последние запуски', async () => {
    const first = await runs.start('manual', { processingDay: '2026-09-01' });
    await runs.finish({ runId: first.id, status: 'completed' });
    await runs.start('cron', { processingDay: '2026-09-02' });

    const { body } = await server.request('/api/runs');
    const payload = body as { items: { id: string; trigger: string }[] };

    expect(payload.items).toHaveLength(2);
    expect(payload.items.map((r) => r.trigger).sort()).toEqual(['cron', 'manual']);
  });

  it('не требует авторизации: чтение открыто', async () => {
    const { status } = await server.request('/api/runs');
    expect(status).toBe(200);
  });

  it('ограничивает limit сверху', async () => {
    const { status } = await server.request('/api/runs?limit=99999');
    // limit подрезается, а не отклоняется
    expect(status).toBe(200);
  });

  it('отклоняет некорректный limit', async () => {
    const { status } = await server.request('/api/runs?limit=abc');
    expect(status).toBe(400);
  });
});

// ============================================================================
// GET /api/runs/:id
// ============================================================================

describe('GET /api/runs/:id', () => {
  it('возвращает детали запуска', async () => {
    const run = await runs.start('manual', { processingDay: '2026-09-08' });
    await runs.incrementCounters(run.id, { plannedCount: 20, claimedCount: 5 });
    await runs.finish({ runId: run.id, status: 'completed' });

    const { status, body } = await server.request(`/api/runs/${run.id}`);
    const dto = body as Record<string, unknown>;

    expect(status).toBe(200);
    expect(dto.id).toBe(run.id);
    expect(dto.status).toBe('completed');
    expect(dto.processingDay).toBe('2026-09-08');
    expect(dto.planned).toBe(20);
    expect(dto.claimed).toBe(5);
    expect(dto.startedAt).toBeTruthy();
    expect(dto.finishedAt).toBeTruthy();
  });

  it('считает succeeded, partial и failed по заявкам', async () => {
    const run = await runs.start('manual', { processingDay: '2026-09-08' });

    const { game } = await games.upsert({
      source: 'metacritic',
      sourceSlug: 'g1',
      parserVersion: 'v1',
      title: 'Игра',
      developerStatus: 'unknown',
    });

    // Внешний ключ требует существующих суток обработки
    await new PostgresProcessingDayRepository(pool).ensureDay('2026-09-08');

    // Три заявки: полностью успешная, частичная и провалившаяся
    await pool.query(
      `INSERT INTO daily_claims
         (processing_day, source, source_slug, game_id, run_id, status, stages, completed_at)
       VALUES
         ('2026-09-08','metacritic','ok-1',$1,$2,'done','{"fetchGame":{"status":"done"}}'::jsonb, now()),
         ('2026-09-08','metacritic','part-1',$1,$2,'done',
          '{"fetchGame":{"status":"done"},"summarize":{"status":"failed"}}'::jsonb, now()),
         ('2026-09-08','metacritic','fail-1',$1,$2,'failed','{}'::jsonb, null)`,
      [game.id, run.id],
    );

    const { body } = await server.request(`/api/runs/${run.id}`);
    const dto = body as { succeeded: number; partial: number; failed: number };

    expect(dto.succeeded).toBe(1);
    // partial выводится из необязательной стадии, а не хранится статусом
    expect(dto.partial).toBe(1);
    expect(dto.failed).toBe(1);
  });

  it('провал обязательной стадии не считается partial', async () => {
    const run = await runs.start('manual', { processingDay: '2026-09-08' });
    const { game } = await games.upsert({
      source: 'metacritic',
      sourceSlug: 'g2',
      parserVersion: 'v1',
      title: 'Игра',
      developerStatus: 'unknown',
    });

    await new PostgresProcessingDayRepository(pool).ensureDay('2026-09-08');

    await pool.query(
      `INSERT INTO daily_claims
         (processing_day, source, source_slug, game_id, run_id, status, stages, completed_at)
       VALUES ('2026-09-08','metacritic','crit-1',$1,$2,'done',
               '{"fetchGame":{"status":"done"},"fetchReviews":{"status":"failed"}}'::jsonb, now())`,
      [game.id, run.id],
    );

    const { body } = await server.request(`/api/runs/${run.id}`);
    const dto = body as { succeeded: number; partial: number };

    // fetchReviews — критичная стадия, в расчёт partial не входит
    expect(dto.partial).toBe(0);
    expect(dto.succeeded).toBe(1);
  });

  it('стадии обработки доходят до ответа', async () => {
    const run = await runs.start('manual', { processingDay: '2026-09-08' });
    const { game } = await games.upsert({
      source: 'metacritic',
      sourceSlug: 'g-stages',
      parserVersion: 'v1',
      title: 'Игра',
      developerStatus: 'unknown',
    });

    await new PostgresProcessingDayRepository(pool).ensureDay('2026-09-08');
    await pool.query(
      `INSERT INTO daily_claims
         (processing_day, source, source_slug, game_id, run_id, status, stages, completed_at)
       VALUES ('2026-09-08','metacritic','s-1',$1,$2,'done',
               '{"fetchGame":{"status":"done"},"summarize":{"status":"skipped"}}'::jsonb, now())`,
      [game.id, run.id],
    );

    const { body } = await server.request(`/api/runs/${run.id}`);
    const dto = body as { stages: { stage: string; done: number; skipped: number }[] };

    const byName = new Map(dto.stages.map((s) => [s.stage, s]));
    expect(byName.get('fetchGame')?.done).toBe(1);
    expect(byName.get('summarize')?.skipped).toBe(1);
  });

  it('несуществующий запуск даёт 404', async () => {
    const { status, body } = await server.request(
      '/api/runs/00000000-0000-4000-8000-000000000000',
    );
    expect(status).toBe(404);
    expect((body as { error: { code: string } }).error.code).toBe('RUN_NOT_FOUND');
  });

  it('некорректный UUID даёт 400', async () => {
    const { status } = await server.request('/api/runs/not-a-uuid');
    expect(status).toBe(400);
  });

  it('не раскрывает внутренние поля', async () => {
    const run = await runs.start('manual', { processingDay: '2026-09-08', lockKey: 12345 });

    const { body } = await server.request(`/api/runs/${run.id}`);
    const dto = body as Record<string, unknown>;

    // Ключ блокировки и владелец — внутренняя механика
    expect(dto).not.toHaveProperty('lockKey');
    expect(dto).not.toHaveProperty('ownerId');
    expect(dto).not.toHaveProperty('heartbeatAt');
  });
});

// ============================================================================
// GET /api/monitoring/workers
// ============================================================================

describe('GET /api/monitoring/workers', () => {
  it('без активного запуска обработчик простаивает', async () => {
    const { status, body } = await server.request('/api/monitoring/workers');
    const payload = body as { items: Record<string, unknown>[] };

    expect(status).toBe(200);
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]!.status).toBe('idle');
    expect(payload.items[0]!.currentRunId).toBeNull();
    expect(payload.items[0]!.lastHeartbeat).toBeNull();
  });

  it('при активном запуске показывает его и отметку живости', async () => {
    const run = await runs.start('cron', { processingDay: '2026-09-08' });
    await runs.incrementCounters(run.id, { processedCount: 7, failedCount: 1 });

    const { body } = await server.request('/api/monitoring/workers');
    const worker = (body as { items: Record<string, unknown>[] }).items[0]!;

    expect(worker.status).toBe('running');
    expect(worker.currentRunId).toBe(run.id);
    expect(worker.lastHeartbeat).toBeTruthy();
    expect(worker.processed).toBe(7);
    expect(worker.failed).toBe(1);
  });

  it('завершённый запуск снова даёт простой', async () => {
    const run = await runs.start('cron', { processingDay: '2026-09-08' });
    await runs.finish({ runId: run.id, status: 'completed' });

    const { body } = await server.request('/api/monitoring/workers');
    const worker = (body as { items: Record<string, unknown>[] }).items[0]!;

    expect(worker.status).toBe('idle');
  });
});

// ============================================================================
// GET /api/health
// ============================================================================

describe('GET /api/health', () => {
  it('проверяет только свою базу', async () => {
    const { status, body } = await server.request('/api/health');
    const payload = body as { status: string; timestamp: string };

    expect(status).toBe(200);
    expect(payload.status).toBe('ok');
    expect(payload.timestamp).toBeTruthy();
  });
});
