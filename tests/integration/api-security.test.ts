import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbPool } from '../../src/shared/db/pool.js';
import { PostgresGameRepository } from '../../src/modules/catalog/infrastructure/postgres-game-repository.js';
import { PostgresGamePlatformRepository } from '../../src/modules/catalog/infrastructure/postgres-game-platform-repository.js';
import { PostgresReviewRepository } from '../../src/modules/reviews/infrastructure/postgres-review-repository.js';
import { PostgresReviewSummaryRepository } from '../../src/modules/analysis/infrastructure/postgres-summary-repository.js';
import { Router } from '../../src/api/server.js';
import {
  createGetGameHandler,
  createListGamesHandler,
  createListReviewsHandler,
  type CatalogDeps,
} from '../../src/api/routes/catalog-routes.js';
import type { Handler } from '../../src/api/server.js';
import { createTestPool, setupSchema, truncateAll } from './helpers.js';
import { startTestServer, type TestServer } from './api-helpers.js';

/**
 * Проверки безопасности API на реальной PostgreSQL.
 *
 * Проверяется, что наружу не уходят ни секреты, ни детали устройства
 * системы, и что вход не управляет запросом к базе.
 */

const DB_PASSWORD_MARKER = 'postgres';

let pool: DbPool;
let games: PostgresGameRepository;
let server: TestServer;

beforeAll(async () => {
  pool = createTestPool();
  await setupSchema(pool);
  games = new PostgresGameRepository(pool);

  const deps: CatalogDeps = {
    games,
    platforms: new PostgresGamePlatformRepository(pool),
    reviews: new PostgresReviewRepository(pool),
    summaries: new PostgresReviewSummaryRepository(pool),
    // Подбор похожих здесь не проверяется
    similar: null,
    videoInsights: null,
    enrichVideo: null,
    pageDefaults: { defaultSize: 20, maxSize: 100 },
  };

  // Обработчик, который заведомо падает: проверяем, что наружу не уходят
  // ни текст ошибки БД, ни трассировка стека.
  const explodingHandler: Handler = async () => {
    await pool.query('SELECT * FROM table_that_does_not_exist_12345');
    return { status: 200, body: {} };
  };

  const secretLeakingHandler: Handler = async () => {
    throw new Error(
      `Сбой подключения: postgres://admin:SUPER_SECRET_PASSWORD@db:5432/x, ключ sk-or-v1-LEAKED`,
    );
  };

  const router = new Router()
    .get('/api/games', createListGamesHandler(deps))
    .get('/api/games/:id', createGetGameHandler(deps))
    .get('/api/games/:id/reviews', createListReviewsHandler(deps))
    .get('/api/boom', explodingHandler)
    .get('/api/leak', secretLeakingHandler);

  server = await startTestServer(router);
});

afterAll(async () => {
  await server.close();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
});

async function seedGame(slug: string, title: string): Promise<string> {
  const { game } = await games.upsert({
    source: 'metacritic',
    sourceSlug: slug,
    parserVersion: 'v1',
    title,
    developerStatus: 'unknown',
  });
  return game.id;
}

// ============================================================================
// Инъекции
// ============================================================================

describe('Устойчивость к инъекциям', () => {
  const payloads = [
    "'; DROP TABLE games; --",
    "' OR '1'='1",
    "1; DELETE FROM games WHERE 1=1; --",
    "%'; UPDATE games SET title='hacked'; --",
    "' UNION SELECT NULL, NULL, NULL --",
  ];

  it('строка поиска не выполняется как SQL', async () => {
    await seedGame('safe', 'Safe Game');

    for (const payload of payloads) {
      const { status } = await server.request(
        `/api/games?q=${encodeURIComponent(payload)}`,
      );
      // Запрос отрабатывает штатно и ничего не находит
      expect(status).toBe(200);
    }

    // Таблица цела, данные не изменены
    const { rows } = await pool.query<{ count: string; title: string }>(
      'SELECT count(*)::text AS count, max(title) AS title FROM games',
    );
    expect(Number(rows[0]!.count)).toBe(1);
    expect(rows[0]!.title).toBe('Safe Game');
  });

  it('процент и подчёркивание в поиске не ломают запрос', async () => {
    await seedGame('g1', '100% Orange Juice');

    const { status, body } = await server.request('/api/games?q=100%25');
    expect(status).toBe(200);
    expect((body as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(0);
  });

  it('инъекция в параметре сортировки отклоняется', async () => {
    const { status } = await server.request(
      `/api/games?sort=${encodeURIComponent('title; DROP TABLE games')}`,
    );
    expect(status).toBe(400);
  });

  it('инъекция в параметре платформы отклоняется', async () => {
    const { status } = await server.request(
      `/api/games?platform=${encodeURIComponent("pc' OR '1'='1")}`,
    );
    expect(status).toBe(400);
  });

  it('таблица остаётся на месте после всех попыток', async () => {
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables WHERE table_name = 'games'
       ) AS exists`,
    );
    expect(rows[0]!.exists).toBe(true);
  });
});

// ============================================================================
// Проверка входа
// ============================================================================

describe('Проверка пути и параметров', () => {
  it('некорректный UUID не доходит до базы', async () => {
    for (const value of ['not-a-uuid', '../../etc/passwd', '1 OR 1=1', '%00']) {
      const { status, body } = await server.request(
        `/api/games/${encodeURIComponent(value)}`,
      );
      expect(status).toBe(400);
      expect((body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('UUID нулевой версии отклоняется', async () => {
    const { status } = await server.request(
      '/api/games/00000000-0000-0000-0000-000000000000',
    );
    expect(status).toBe(400);
  });

  it('чрезмерный pageSize отклоняется', async () => {
    for (const size of ['101', '1000', '999999']) {
      const { status } = await server.request(`/api/games?pageSize=${size}`);
      expect(status).toBe(400);
    }
  });

  it('слишком длинная строка поиска отклоняется', async () => {
    const long = 'а'.repeat(500);
    const { status } = await server.request(`/api/games?q=${encodeURIComponent(long)}`);
    expect(status).toBe(400);
  });

  it('недопустимые значения перечислений отклоняются', async () => {
    const id = await seedGame('g1', 'Игра');

    const cases = [
      '/api/games?sort=__proto__',
      '/api/games?order=DESC;DROP',
      `/api/games/${id}/reviews?kind=admin`,
    ];

    for (const path of cases) {
      const { status } = await server.request(path);
      expect(status).toBe(400);
    }
  });

  it('несуществующий путь даёт 404 в общем формате', async () => {
    const { status, body } = await server.request('/api/unknown-endpoint');
    const payload = body as { error: { code: string; requestId: string } };

    expect(status).toBe(404);
    expect(payload.error.code).toBe('NOT_FOUND');
    expect(payload.error.requestId).toBeTruthy();
  });
});

// ============================================================================
// Утечки
// ============================================================================

describe('Отсутствие утечек в ответах', () => {
  it('внутренний сбой не раскрывает ошибку базы', async () => {
    const { status, body } = await server.request('/api/boom');
    const serialized = JSON.stringify(body);

    expect(status).toBe(500);
    expect((body as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR');

    // Ни имени таблицы, ни текста ошибки PostgreSQL
    expect(serialized).not.toContain('table_that_does_not_exist_12345');
    expect(serialized).not.toContain('relation');
    expect(serialized.toLowerCase()).not.toContain('syntax');
  });

  it('внутренний сбой не раскрывает трассировку стека', async () => {
    const { body } = await server.request('/api/boom');
    const serialized = JSON.stringify(body);

    expect(serialized).not.toContain('at ');
    expect(serialized).not.toContain('.ts:');
    expect(serialized).not.toContain('node_modules');
    expect(body).not.toHaveProperty('stack');
    expect(body).not.toHaveProperty('error.stack');
  });

  it('секреты из текста ошибки не попадают в ответ', async () => {
    const { status, body } = await server.request('/api/leak');
    const serialized = JSON.stringify(body);

    expect(status).toBe(500);
    expect(serialized).not.toContain('SUPER_SECRET_PASSWORD');
    expect(serialized).not.toContain('sk-or-v1-LEAKED');
    expect(serialized).not.toContain(DB_PASSWORD_MARKER);
  });

  it('ошибка валидации не отражает присланное значение', async () => {
    const marker = 'ЗНАЧЕНИЕ_КЛИЕНТА_12345';

    const { body } = await server.request(
      `/api/games?sort=${encodeURIComponent(marker)}`,
    );
    const serialized = JSON.stringify(body);

    // Иначе ответ стал бы способом отражать произвольный текст
    expect(serialized).not.toContain(marker);
  });

  it('каждый ответ об ошибке содержит requestId', async () => {
    const paths = ['/api/unknown', '/api/games?page=0', '/api/boom'];

    for (const path of paths) {
      const { body, headers } = await server.request(path);
      const payload = body as { error: { requestId: string } };

      expect(payload.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
      // Тот же идентификатор доступен в заголовке
      expect(headers.get('x-request-id')).toBe(payload.error.requestId);
    }
  });

  it('идентификаторы запросов различаются', async () => {
    const first = await server.request('/api/unknown');
    const second = await server.request('/api/unknown');

    const id1 = (first.body as { error: { requestId: string } }).error.requestId;
    const id2 = (second.body as { error: { requestId: string } }).error.requestId;

    expect(id1).not.toBe(id2);
  });
});

// ============================================================================
// Недоверенное содержимое
// ============================================================================

describe('Недоверенное содержимое отзывов', () => {
  it('текст отзыва отдаётся как данные, без исполнения', async () => {
    const id = await seedGame('untrusted', 'Игра');

    const malicious = '<script>alert(1)</script> и {{7*7}}';
    await pool.query(
      `INSERT INTO reviews
         (game_id, kind, platform_slug, external_id, quote, content_hash)
       VALUES ($1, 'user', 'pc', 'u1', $2, 'hash-1')`,
      [id, malicious],
    );

    const { status, body } = await server.request(`/api/games/${id}/reviews?kind=user`);
    const payload = body as { items: { quote: string }[] };

    expect(status).toBe(200);
    // Текст доходит без изменений: экранирование — забота клиента,
    // подстановка на сервере не выполняется
    expect(payload.items[0]!.quote).toBe(malicious);
  });
});
