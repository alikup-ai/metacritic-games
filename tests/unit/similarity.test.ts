import { describe, expect, it } from 'vitest';
import {
  compareGames,
  findSimilarGames,
  MAX_SIMILAR,
  type SimilarityCandidate,
} from '../../src/modules/similarity/domain/similarity.js';

/**
 * Подбор похожих игр.
 *
 * Правила чистые: ни базы, ни сети, ни модели. Проверяется, что результат
 * объясним и воспроизводим.
 */

function game(overrides: Partial<SimilarityCandidate> & { id: string }): SimilarityCandidate {
  return {
    title: `Игра ${overrides.id}`,
    coverUrl: null,
    releaseDate: '2026-01-01',
    developer: 'Studio A',
    publishers: ['Publisher A'],
    genres: ['Action RPG'],
    metascore: 80,
    userscore: 8,
    platforms: ['pc'],
    ...overrides,
  };
}

describe('Сравнение двух игр', () => {
  it('полное совпадение признаков даёт высокую близость', () => {
    const result = compareGames(game({ id: 'a' }), game({ id: 'b' }));

    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThan(0.9);
  });

  it('игра не похожа сама на себя', () => {
    const target = game({ id: 'a' });
    expect(compareGames(target, target)).toBeNull();
  });

  it('полностью разные игры отсеиваются', () => {
    const target = game({ id: 'a' });
    const other = game({
      id: 'b',
      genres: ['4X Strategy'],
      developer: 'Studio Z',
      publishers: ['Publisher Z'],
      platforms: ['nintendo-switch'],
      metascore: 40,
      releaseDate: '2010-01-01',
    });

    // Показывать случайные игры хуже, чем не показывать ничего
    expect(compareGames(target, other)).toBeNull();
  });

  it('совпадение жанра вносит наибольший вклад', () => {
    const target = game({ id: 'a', developer: 'X', publishers: [], platforms: [], metascore: null });
    const sameGenre = game({
      id: 'b',
      developer: 'Y',
      publishers: [],
      platforms: [],
      metascore: null,
      releaseDate: null,
    });

    const result = compareGames(target, sameGenre);
    expect(result!.reasons[0]!.kind).toBe('genre');
  });

  it('одинаковый разработчик распознаётся независимо от регистра', () => {
    const target = game({ id: 'a', developer: 'CD Projekt Red' });
    const other = game({ id: 'b', developer: '  cd projekt red  ', genres: ['Other'] });

    const result = compareGames(target, other);
    expect(result!.reasons.some((r) => r.kind === 'developer')).toBe(true);
  });

  it('отсутствие оценки не считается нулём', () => {
    const target = game({ id: 'a', metascore: null });
    const other = game({ id: 'b', metascore: 90 });

    const result = compareGames(target, other);
    // Признак оценок не участвует, если она неизвестна
    expect(result!.reasons.some((r) => r.kind === 'score')).toBe(false);
  });

  it('далёкие оценки не дают вклада', () => {
    const target = game({ id: 'a', metascore: 95 });
    const other = game({ id: 'b', metascore: 40 });

    const result = compareGames(target, other);
    expect(result!.reasons.some((r) => r.kind === 'score')).toBe(false);
  });

  it('близкие оценки дают вклад', () => {
    const target = game({ id: 'a', metascore: 85 });
    const other = game({ id: 'b', metascore: 88 });

    const result = compareGames(target, other);
    expect(result!.reasons.some((r) => r.kind === 'score')).toBe(true);
  });

  it('игры разных эпох не сближаются по времени', () => {
    const target = game({ id: 'a', releaseDate: '2026-01-01' });
    const other = game({ id: 'b', releaseDate: '2005-01-01' });

    const result = compareGames(target, other);
    expect(result!.reasons.some((r) => r.kind === 'era')).toBe(false);
  });

  it('пустые поля не ломают сравнение', () => {
    const target = game({ id: 'a', genres: [], publishers: [], platforms: [], developer: null });
    const other = game({ id: 'b', genres: [], publishers: [], platforms: [], developer: null });

    // Общих признаков нет — сходство не утверждается
    expect(compareGames(target, other)).toBeNull();
  });
});

describe('Объяснение сходства', () => {
  it('каждая причина имеет понятную формулировку', () => {
    const result = compareGames(game({ id: 'a' }), game({ id: 'b' }));

    expect(result!.reasons.length).toBeGreaterThan(0);
    for (const reason of result!.reasons) {
      expect(reason.label.length).toBeGreaterThan(0);
      // Формулировка на русском, а не машинный код признака
      expect(reason.label).not.toBe(reason.kind);
    }
  });

  it('причины упорядочены по вкладу', () => {
    const result = compareGames(game({ id: 'a' }), game({ id: 'b' }));
    const weights = result!.reasons.map((r) => r.weight);

    expect(weights).toEqual([...weights].sort((x, y) => y - x));
  });

  it('в объяснении назван конкретный жанр', () => {
    const result = compareGames(
      game({ id: 'a', genres: ['Action RPG'] }),
      game({ id: 'b', genres: ['Action RPG'] }),
    );

    const genre = result!.reasons.find((r) => r.kind === 'genre');
    expect(genre!.label).toContain('Action RPG');
  });

  it('в объяснении назван конкретный разработчик', () => {
    const result = compareGames(
      game({ id: 'a', developer: 'Team Cherry' }),
      game({ id: 'b', developer: 'Team Cherry' }),
    );

    const dev = result!.reasons.find((r) => r.kind === 'developer');
    expect(dev!.label).toContain('Team Cherry');
  });
});

describe('Подбор списка', () => {
  const target = game({ id: 'target' });

  it('возвращает не более пяти игр', () => {
    const candidates = Array.from({ length: 12 }, (_, i) => game({ id: `c${i}` }));
    const result = findSimilarGames(target, candidates);

    expect(result).toHaveLength(MAX_SIMILAR);
  });

  it('сама игра не попадает в результат', () => {
    const candidates = [target, game({ id: 'other' })];
    const result = findSimilarGames(target, candidates);

    expect(result.every((r) => r.candidate.id !== target.id)).toBe(true);
  });

  it('при отсутствии похожих возвращает пустой список', () => {
    const candidates = [
      game({
        id: 'x',
        genres: ['4X Strategy'],
        developer: 'Z',
        publishers: ['Z'],
        platforms: ['xbox'],
        metascore: 30,
        releaseDate: '2000-01-01',
      }),
    ];

    expect(findSimilarGames(target, candidates)).toEqual([]);
  });

  it('пустой каталог даёт пустой список', () => {
    expect(findSimilarGames(target, [])).toEqual([]);
  });

  it('при малом числе кандидатов возвращает меньше пяти', () => {
    const result = findSimilarGames(target, [game({ id: 'a' }), game({ id: 'b' })]);
    expect(result).toHaveLength(2);
  });

  it('результат отсортирован по убыванию близости', () => {
    const candidates = [
      game({ id: 'weak', genres: ['Other'], developer: 'Z', publishers: ['Z'] }),
      game({ id: 'strong' }),
      game({ id: 'medium', developer: 'Z' }),
    ];

    const scores = findSimilarGames(target, candidates).map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});

describe('Воспроизводимость', () => {
  const target = game({ id: 'target' });

  it('повторный вызов даёт тот же результат', () => {
    const candidates = Array.from({ length: 8 }, (_, i) => game({ id: `c${i}` }));

    const first = findSimilarGames(target, candidates);
    const second = findSimilarGames(target, candidates);

    expect(first.map((r) => r.candidate.id)).toEqual(second.map((r) => r.candidate.id));
    expect(first.map((r) => r.score)).toEqual(second.map((r) => r.score));
  });

  it('порядок кандидатов не влияет на результат', () => {
    const candidates = Array.from({ length: 8 }, (_, i) => game({ id: `c${i}` }));

    const straight = findSimilarGames(target, candidates);
    const reversed = findSimilarGames(target, [...candidates].reverse());

    // При равной близости порядок задаётся идентификатором
    expect(straight.map((r) => r.candidate.id)).toEqual(reversed.map((r) => r.candidate.id));
  });

  it('близость не превышает единицы', () => {
    const result = findSimilarGames(target, [game({ id: 'a' })]);
    expect(result[0]!.score).toBeLessThanOrEqual(1);
  });
});
