import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbPool } from '../../src/shared/db/pool.js';
import { PostgresGameRepository } from '../../src/modules/catalog/infrastructure/postgres-game-repository.js';
import { PostgresGamePlatformRepository } from '../../src/modules/catalog/infrastructure/postgres-game-platform-repository.js';
import type { Game, GameUpsertInput } from '../../src/modules/catalog/domain/game.js';
import { createTestPool, setupSchema, truncateAll } from './helpers.js';

let pool: DbPool;
let repo: PostgresGameRepository;
let platformRepo: PostgresGamePlatformRepository;

beforeAll(async () => {
  pool = createTestPool();
  await setupSchema(pool);
  repo = new PostgresGameRepository(pool);
  platformRepo = new PostgresGamePlatformRepository(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
});

/** upsert возвращает {game, created}; тестам нужна сама игра. */
function unwrap(result: { game: Game }): Game {
  return result.game;
}

function gameInput(overrides: Partial<GameUpsertInput> = {}): GameUpsertInput {
  return {
    source: 'metacritic',
    sourceSlug: 'elden-ring',
    parserVersion: 'v1',
    title: 'Elden Ring',
    developer: 'From Software',
    developerStatus: 'resolved',
    publishers: ['Bandai Namco Games', 'From Software'],
    genres: ['Action RPG'],
    releaseDate: '2022-02-25',
    metascoreOverall: 96,
    userscoreOverall: 8.4,
    ...overrides,
  };
}

describe('upsert — обновление вместо дублирования (требование ТЗ)', () => {
  it('создаёт игру', async () => {
    const game = unwrap(await repo.upsert(gameInput()));
    expect(game.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(game.title).toBe('Elden Ring');
    expect(game.developer).toBe('From Software');
  });

  it('повторный обход ОБНОВЛЯЕТ ту же игру, а не создаёт вторую', async () => {
    const first = unwrap(await repo.upsert(gameInput()));
    const second = unwrap(await repo.upsert(gameInput({ metascoreOverall: 97 })));

    expect(second.id).toBe(first.id);
    expect(second.metascoreOverall).toBe(97);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM games',
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('сохраняет first_seen_at при обновлении', async () => {
    const first = unwrap(await repo.upsert(gameInput()));
    await new Promise((r) => setTimeout(r, 50));
    const second = unwrap(await repo.upsert(gameInput({ title: 'Elden Ring: Updated' })));

    expect(second.firstSeenAt.getTime()).toBe(first.firstSeenAt.getTime());
    expect(second.lastUpdatedAt.getTime()).toBeGreaterThanOrEqual(
      first.lastUpdatedAt.getTime(),
    );
  });

  it('различает игры с одинаковым названием по слагу', async () => {
    await repo.upsert(gameInput({ sourceSlug: 'doom-1993', title: 'DOOM' }));
    await repo.upsert(gameInput({ sourceSlug: 'doom-2016', title: 'DOOM' }));

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM games',
    );
    expect(rows[0]?.count).toBe('2');
  });
});

describe('developer / publisher (ADR-0003)', () => {
  it('сохраняет разработчика и издателя раздельно', async () => {
    const game = unwrap(await repo.upsert(
      gameInput({
        developer: 'IllFonic',
        developerStatus: 'resolved',
        publishers: ['Gun Interactive', 'IllFonic'],
      }),
    ));

    expect(game.developer).toBe('IllFonic');
    expect(game.publishers).toContain('Gun Interactive');
    // Издатель не подменяет разработчика
    expect(game.developer).not.toBe('Gun Interactive');
  });

  it('сохраняет отсутствующего разработчика как unknown (реальный случай)', async () => {
    const game = unwrap(await repo.upsert(
      gameInput({
        sourceSlug: 'the-blood-of-dawnwalker',
        title: 'The Blood of Dawnwalker',
        developer: null,
        developerStatus: 'unknown',
        publishers: ['Bandai Namco Games'],
      }),
    ));

    expect(game.developer).toBeNull();
    expect(game.developerStatus).toBe('unknown');
    // Издатель есть, но в поле разработчика не попал
    expect(game.publishers).toContain('Bandai Namco Games');
  });

  it('БД отвергает resolved без указанного разработчика', async () => {
    await expect(
      pool.query(
        `INSERT INTO games (source, source_slug, parser_version, title, developer, developer_status)
         VALUES ('metacritic', 'bad', 'v1', 'Bad', NULL, 'resolved')`,
      ),
    ).rejects.toThrow(/games_developer_consistency/);
  });
});

describe('платформы и score_scope (ADR-0008)', () => {
  it('сохраняет несколько платформ с разными оценками', async () => {
    const game = unwrap(await repo.upsert(gameInput()));
    await platformRepo.replacePlatformSnapshot(game.id, [
      {
        platformSlug: 'pc',
        platformName: 'PC',
        metascore: 94,
        metascoreScope: 'platform',
        userscore: null,
        userscoreScope: 'overall_fallback',
        criticCount: 63,
        userCount: null,
      },
      {
        platformSlug: 'xbox-series-x',
        platformName: 'Xbox Series X',
        metascore: 96,
        metascoreScope: 'platform',
        userscore: null,
        userscoreScope: 'overall_fallback',
        criticCount: 19,
        userCount: null,
      },
    ]);

    const platforms = await platformRepo.findActiveByGameId(game.id);
    expect(platforms).toHaveLength(2);
    // Оценки различаются между платформами — подтверждено исследованием
    expect(platforms.find((p) => p.platformSlug === 'pc')?.metascore).toBe(94);
    expect(platforms.find((p) => p.platformSlug === 'xbox-series-x')?.metascore).toBe(96);
  });

  it('сохраняет платформу без оценки (tbd) как NULL', async () => {
    const game = unwrap(await repo.upsert(gameInput()));
    await platformRepo.replacePlatformSnapshot(game.id, [
      {
        platformSlug: 'playstation-4',
        platformName: 'PlayStation 4',
        metascore: null,
        metascoreScope: 'platform',
        userscore: null,
        userscoreScope: 'overall_fallback',
        criticCount: 1,
        userCount: null,
      },
    ]);

    const platforms = await platformRepo.findActiveByGameId(game.id);
    // Платформа известна, оценки ещё нет — это не ошибка
    expect(platforms[0]?.metascore).toBeNull();
    expect(platforms[0]?.metascoreScope).toBe('platform');
  });

  it('исчезнувшая платформа ОТКЛЮЧАЕТСЯ, а не удаляется (ADR-0011)', async () => {
    const game = unwrap(await repo.upsert(gameInput()));
    await platformRepo.replacePlatformSnapshot(game.id, [
      {
        platformSlug: 'pc',
        platformName: 'PC',
        metascore: 94,
        metascoreScope: 'platform',
        userscore: null,
        userscoreScope: 'overall_fallback',
        criticCount: null,
        userCount: null,
      },
    ]);
    await platformRepo.replacePlatformSnapshot(game.id, [
      {
        platformSlug: 'playstation-5',
        platformName: 'PlayStation 5',
        metascore: 96,
        metascoreScope: 'platform',
        userscore: null,
        userscoreScope: 'overall_fallback',
        criticCount: null,
        userCount: null,
      },
    ]);

    // Активной осталась только платформа из последнего снимка
    const active = await platformRepo.findActiveByGameId(game.id);
    expect(active).toHaveLength(1);
    expect(active[0]?.platformSlug).toBe('playstation-5');

    // Но данные исчезнувшей платформы сохранены, а не стёрты
    const all = await platformRepo.findAllByGameId(game.id);
    expect(all).toHaveLength(2);
    const pc = all.find((p) => p.platformSlug === 'pc');
    expect(pc?.isActive).toBe(false);
    expect(pc?.metascore).toBe(94);
    expect(pc?.deactivatedAt).not.toBeNull();
  });

  it('отвергает недопустимое значение score_scope', async () => {
    const game = unwrap(await repo.upsert(gameInput()));
    await expect(
      pool.query(
        `INSERT INTO game_platforms (game_id, platform_slug, platform_name, metascore_scope, userscore_scope)
         VALUES ($1, 'pc', 'PC', 'made_up', 'overall_fallback')`,
        [game.id],
      ),
    ).rejects.toThrow(/metascore_scope_valid/);
  });

  it('удаление игры каскадно удаляет её платформы', async () => {
    const game = unwrap(await repo.upsert(gameInput()));
    await platformRepo.replacePlatformSnapshot(game.id, [
      {
        platformSlug: 'pc',
        platformName: 'PC',
        metascore: 94,
        metascoreScope: 'platform',
        userscore: null,
        userscoreScope: 'overall_fallback',
        criticCount: null,
        userCount: null,
      },
    ]);

    await pool.query('DELETE FROM games WHERE id = $1', [game.id]);
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM game_platforms WHERE game_id = $1',
      [game.id],
    );
    expect(rows[0]?.count).toBe('0');
  });
});

describe('list — поиск, фильтр, сортировка', () => {
  beforeEach(async () => {
    const a = unwrap(await repo.upsert(
      gameInput({ sourceSlug: 'elden-ring', title: 'Elden Ring', metascoreOverall: 96 }),
    ));
    const b = unwrap(await repo.upsert(
      gameInput({ sourceSlug: 'hades-ii', title: 'Hades II', metascoreOverall: 92 }),
    ));
    await repo.upsert(
      gameInput({ sourceSlug: 'indie-x', title: 'Indie X', metascoreOverall: null }),
    );

    await platformRepo.replacePlatformSnapshot(a.id, [
      {
        platformSlug: 'playstation-5',
        platformName: 'PlayStation 5',
        metascore: 96,
        metascoreScope: 'platform',
        userscore: null,
        userscoreScope: 'overall_fallback',
        criticCount: null,
        userCount: null,
      },
    ]);
    await platformRepo.replacePlatformSnapshot(b.id, [
      {
        platformSlug: 'pc',
        platformName: 'PC',
        metascore: 92,
        metascoreScope: 'platform',
        userscore: null,
        userscoreScope: 'overall_fallback',
        criticCount: null,
        userCount: null,
      },
    ]);
  });

  it('сортирует по рейтингу, помещая игры без оценки в конец', async () => {
    const result = await repo.list({ sortBy: 'metascore', sortDirection: 'desc' });
    expect(result.items[0]?.title).toBe('Elden Ring');
    expect(result.items[1]?.title).toBe('Hades II');
    expect(result.items[2]?.metascoreOverall).toBeNull();
  });

  it('ищет по названию без учёта регистра', async () => {
    const result = await repo.list({ search: 'elden' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe('Elden Ring');
  });

  it('фильтрует по платформе', async () => {
    const result = await repo.list({ platformSlugs: ['playstation-5'] });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe('Elden Ring');
  });

  it('возвращает общее число записей для пагинации', async () => {
    const result = await repo.list({ limit: 2, offset: 0 });
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(3);
  });

  it('не ломается на спецсимволах в поиске (защита от инъекций)', async () => {
    const result = await repo.list({ search: "'; DROP TABLE games; --" });
    expect(result.items).toHaveLength(0);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM games',
    );
    expect(rows[0]?.count).toBe('3');
  });

  it('отдаёт список платформ для фильтра', async () => {
    const platforms = await platformRepo.listDistinctPlatforms();
    expect(platforms.map((p) => p.slug).sort()).toEqual(['pc', 'playstation-5']);
  });
});
