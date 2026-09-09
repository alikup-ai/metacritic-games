import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbPool } from '../../src/shared/db/pool.js';
import { PostgresGameRepository } from '../../src/modules/catalog/infrastructure/postgres-game-repository.js';
import { PostgresGamePlatformRepository } from '../../src/modules/catalog/infrastructure/postgres-game-platform-repository.js';
import { FindSimilarGamesUseCase } from '../../src/modules/similarity/application/find-similar-games.js';
import { createTestPool, setupSchema, truncateAll } from './helpers.js';

/**
 * Подбор похожих игр на РЕАЛЬНОЙ PostgreSQL.
 *
 * Проверяется, что данные корректно доходят из базы до правил подбора:
 * массивы, числовые типы и активность платформ.
 */

let pool: DbPool;
let games: PostgresGameRepository;
let platforms: PostgresGamePlatformRepository;
let useCase: FindSimilarGamesUseCase;

async function seed(params: {
  slug: string;
  title: string;
  genres?: string[];
  developer?: string | null;
  publishers?: string[];
  metascore?: number | null;
  releaseDate?: string | null;
  platforms?: string[];
  inactivePlatform?: string;
}): Promise<string> {
  const { game } = await games.upsert({
    source: 'metacritic',
    sourceSlug: params.slug,
    parserVersion: 'v1',
    title: params.title,
    developer: params.developer === undefined ? 'Studio A' : params.developer,
    developerStatus: params.developer === null ? 'unknown' : 'resolved',
    publishers: params.publishers ?? ['Publisher A'],
    genres: params.genres ?? ['Action RPG'],
    releaseDate: params.releaseDate === undefined ? '2026-01-01' : params.releaseDate,
    metascoreOverall: params.metascore === undefined ? 80 : params.metascore,
    userscoreOverall: 8,
  });

  const slugs = params.platforms ?? ['pc'];
  const snapshot = slugs.map((slug) => ({
    platformSlug: slug,
    platformName: slug.toUpperCase(),
    metascore: 80,
    metascoreScope: 'platform' as const,
    userscore: null,
    userscoreScope: 'overall' as const,
    criticCount: 5,
    userCount: null,
  }));

  if (params.inactivePlatform) {
    // Платформа сначала есть, затем исчезает из снимка -> отключается
    await platforms.replacePlatformSnapshot(game.id, [
      ...snapshot,
      {
        platformSlug: params.inactivePlatform,
        platformName: params.inactivePlatform.toUpperCase(),
        metascore: 70,
        metascoreScope: 'platform' as const,
        userscore: null,
        userscoreScope: 'overall' as const,
        criticCount: 3,
        userCount: null,
      },
    ]);
  }

  await platforms.replacePlatformSnapshot(game.id, snapshot);
  return game.id;
}

beforeAll(async () => {
  pool = createTestPool();
  await setupSchema(pool);
  games = new PostgresGameRepository(pool);
  platforms = new PostgresGamePlatformRepository(pool);
  useCase = new FindSimilarGamesUseCase({ games, candidateLimit: 500 });
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
});

describe('Подбор на реальных данных', () => {
  it('находит игру того же жанра и разработчика', async () => {
    const target = await seed({ slug: 'target', title: 'Целевая' });
    await seed({ slug: 'similar', title: 'Похожая' });

    const result = await useCase.execute({ gameId: target });

    expect(result).toHaveLength(1);
    expect(result[0]!.candidate.title).toBe('Похожая');
    expect(result[0]!.reasons.length).toBeGreaterThan(0);
  });

  it('сама игра в результат не попадает', async () => {
    const target = await seed({ slug: 'target', title: 'Целевая' });
    await seed({ slug: 'other', title: 'Другая' });

    const result = await useCase.execute({ gameId: target });
    expect(result.every((r) => r.candidate.id !== target)).toBe(true);
  });

  it('несуществующая игра даёт пустой список', async () => {
    const result = await useCase.execute({
      gameId: '00000000-0000-4000-8000-000000000000',
    });
    expect(result).toEqual([]);
  });

  it('пустой каталог даёт пустой список', async () => {
    const target = await seed({ slug: 'lonely', title: 'Одинокая' });
    const result = await useCase.execute({ gameId: target });
    expect(result).toEqual([]);
  });

  it('несвязанные игры не предлагаются', async () => {
    const target = await seed({ slug: 'target', title: 'Целевая' });
    await seed({
      slug: 'unrelated',
      title: 'Несвязанная',
      genres: ['4X Strategy'],
      developer: 'Studio Z',
      publishers: ['Publisher Z'],
      platforms: ['nintendo-switch'],
      metascore: 30,
      releaseDate: '2005-01-01',
    });

    expect(await useCase.execute({ gameId: target })).toEqual([]);
  });

  it('возвращает не более пяти игр', async () => {
    const target = await seed({ slug: 'target', title: 'Целевая' });
    for (let i = 0; i < 8; i += 1) {
      await seed({ slug: `c${i}`, title: `Кандидат ${i}` });
    }

    const result = await useCase.execute({ gameId: target });
    expect(result).toHaveLength(5);
  });

  it('отключённые платформы не учитываются', async () => {
    const target = await seed({
      slug: 'target',
      title: 'Целевая',
      genres: ['Unique Genre'],
      developer: 'Solo Studio',
      publishers: ['Solo Publisher'],
      platforms: ['pc'],
    });
    await seed({
      slug: 'other',
      title: 'Другая',
      genres: ['Other Genre'],
      developer: 'Another Studio',
      publishers: ['Another Publisher'],
      platforms: ['playstation-5'],
      // Общая платформа есть, но она отключена
      inactivePlatform: 'pc',
    });

    // Единственное возможное пересечение отключено, содержательных
    // признаков не остаётся
    expect(await useCase.execute({ gameId: target })).toEqual([]);
  });

  it('массивы и числа корректно читаются из базы', async () => {
    const target = await seed({
      slug: 'target',
      title: 'Целевая',
      genres: ['Action RPG'],
      publishers: ['Publisher A', 'Publisher B'],
      metascore: 85,
    });
    await seed({
      slug: 'similar',
      title: 'Похожая',
      genres: ['Action RPG'],
      publishers: ['Publisher B'],
      metascore: 88,
    });

    const result = await useCase.execute({ gameId: target });
    const kinds = result[0]!.reasons.map((r) => r.kind);

    expect(kinds).toContain('genre');
    expect(kinds).toContain('publisher');
    // Близкие метаскоры распознаны, значит numeric приведён к числу
    expect(kinds).toContain('score');
  });

  it('результат воспроизводим между вызовами', async () => {
    const target = await seed({ slug: 'target', title: 'Целевая' });
    for (let i = 0; i < 6; i += 1) {
      await seed({ slug: `c${i}`, title: `Кандидат ${i}` });
    }

    const first = await useCase.execute({ gameId: target });
    const second = await useCase.execute({ gameId: target });

    expect(first.map((r) => r.candidate.id)).toEqual(second.map((r) => r.candidate.id));
  });

  it('игра без оценки не ломает подбор', async () => {
    const target = await seed({ slug: 'target', title: 'Целевая', metascore: null });
    await seed({ slug: 'similar', title: 'Похожая', metascore: null });

    const result = await useCase.execute({ gameId: target });
    expect(result).toHaveLength(1);
    expect(result[0]!.reasons.some((r) => r.kind === 'score')).toBe(false);
  });
});
