import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import {
  extractDeveloper,
  parseGameDetail,
} from '../../src/modules/ingestion/infrastructure/parsers/game-detail-parser.js';
import { ParseError } from '../../src/modules/ingestion/domain/ingestion-errors.js';

/** Тесты работают только на фикстурах: сеть не используется. */

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'metacritic',
);

const load = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const parse = (file: string, slug: string) =>
  parseGameDetail(load(file), {
    sourceSlug: slug,
    url: `https://www.metacritic.com/game/${slug}/`,
  });

describe('Developer — обе формы разметки (ADR-0003)', () => {
  it('форма A: разработчик как ссылка на /company/', () => {
    const game = parse('game-elden-ring.html', 'elden-ring');

    expect(game.developer).toBe('From Software');
    expect(game.developerStatus).toBe('resolved');
  });

  it('форма B: разработчик простым текстом, без ссылки', () => {
    const game = parse('game-developer-plain-text.html', 'the-blood-of-dawnwalker');

    // Поиск только по href терял бы разработчика у большинства новых игр
    expect(game.developer).toBe('Rebel Wolves');
    expect(game.developerStatus).toBe('resolved');
  });

  it('вторая игра со ссылочной формой', () => {
    const game = parse('game-witcher-3.html', 'the-witcher-3-wild-hunt');
    expect(game.developer).toBe('CD Projekt Red Studio');
    expect(game.developerStatus).toBe('resolved');
  });

  it('пустой блок разработчика -> null + unknown', () => {
    const game = parse('game-developer-missing.html', 'fixture-missing');

    expect(game.developer).toBeNull();
    expect(game.developerStatus).toBe('unknown');
  });

  it('блок разработчика отсутствует вовсе -> null + unknown', () => {
    const html = `
      <div id="fx-title"><div data-testid="hero-title"><h1>Игра без блока</h1></div></div>`;
    const game = parseGameDetail(html, { sourceSlug: 'x', url: '/game/x/' });

    expect(game.developer).toBeNull();
    expect(game.developerStatus).toBe('unknown');
  });

  it('подпись "Developer:" не попадает в значение', () => {
    const html = `
      <div data-testid="hero-summary-developer">
        <p><span>Developer:</span><span>Studio Name</span></p>
      </div>`;
    const { developer, developerStatus } = extractDeveloper(cheerio.load(html));

    expect(developer).toBe('Studio Name');
    expect(developerStatus).toBe('resolved');
  });
});

describe('НЕГАТИВНЫЕ: publisher никогда не становится developer', () => {
  it('при пустом developer издатель из JSON-LD не подставляется', () => {
    const game = parse('game-developer-missing.html', 'fixture-missing');

    // В фикстуре есть publisher "Some Publisher Ltd"
    expect(game.publishers).toContain('Some Publisher Ltd');
    // но developer остаётся пустым
    expect(game.developer).toBeNull();
    expect(game.developer).not.toBe('Some Publisher Ltd');
  });

  it('developer и publisher хранятся раздельно', () => {
    const game = parse('game-elden-ring.html', 'elden-ring');

    expect(game.developer).toBe('From Software');
    // JSON-LD publisher смешивает издателя и разработчика — но в поле
    // developer попадает только значение из DOM-блока
    expect(game.publishers.length).toBeGreaterThan(0);
    expect(game.publishers).toContain('Bandai Namco Games');
  });

  it('игра только с publisher и без developer не получает подмены', () => {
    const html = `
      <div data-testid="hero-title"><h1>Only Publisher</h1></div>
      <script type="application/ld+json">
        {"@type":"VideoGame","name":"Only Publisher",
         "publisher":[{"@type":"Organization","name":"Big Publisher"}]}
      </script>`;

    const game = parseGameDetail(html, { sourceSlug: 'op', url: '/game/op/' });
    expect(game.publishers).toEqual(['Big Publisher']);
    expect(game.developer).toBeNull();
    expect(game.developerStatus).toBe('unknown');
  });
});

describe('Платформы и оценки (ADR-0008)', () => {
  it('multi-platform игра: оценки привязаны к платформам', () => {
    const game = parse('game-elden-ring.html', 'elden-ring');
    const byPlatform = new Map(game.platforms.map((p) => [p.platform, p]));

    expect(game.platforms.length).toBeGreaterThanOrEqual(3);
    expect(byPlatform.get('pc')?.metascore).toBe(94);
    expect(byPlatform.get('xbox-series-x')?.metascore).toBe(96);
    expect(byPlatform.get('playstation-5')?.metascore).toBe(96);
  });

  it('оценки РАЗЛИЧАЮТСЯ между платформами — связь не выдумана', () => {
    const game = parse('game-witcher-3.html', 'the-witcher-3-wild-hunt');
    const scores = game.platforms
      .map((p) => p.metascore)
      .filter((score): score is number => score !== null);

    expect(scores.length).toBeGreaterThanOrEqual(3);
    expect(new Set(scores).size).toBeGreaterThan(1);
  });

  it('metascoreScope = platform при достоверной привязке', () => {
    const game = parse('game-elden-ring.html', 'elden-ring');
    for (const platform of game.platforms) {
      expect(platform.metascoreScope).toBe('platform');
    }
  });

  it('платформа со статусом tbd сохраняется с metascore = null', () => {
    const game = parse('game-elden-ring.html', 'elden-ring');
    const tbd = game.platforms.filter((p) => p.metascore === null);

    expect(tbd.length).toBeGreaterThan(0);
    // Платформа известна, оценки ещё нет — это не ошибка
    for (const platform of tbd) {
      expect(platform.platform.length).toBeGreaterThan(0);
      expect(platform.metascoreScope).toBe('platform');
    }
  });

  it('извлекается количество рецензий критиков', () => {
    const game = parse('game-elden-ring.html', 'elden-ring');
    const pc = game.platforms.find((p) => p.platform === 'pc');
    expect(pc?.criticCount).toBe(63);
  });

  it('название платформы нормализуется в стабильный код', () => {
    const game = parse('game-elden-ring.html', 'elden-ring');
    const slugs = game.platforms.map((p) => p.platform);

    expect(slugs).toContain('playstation-5');
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe('НЕГАТИВНЫЕ: Userscore не приписывается платформе', () => {
  it('userscore платформы всегда null', () => {
    for (const [file, slug] of [
      ['game-elden-ring.html', 'elden-ring'],
      ['game-witcher-3.html', 'the-witcher-3-wild-hunt'],
    ] as const) {
      const game = parse(file, slug);
      for (const platform of game.platforms) {
        expect(platform.userscore).toBeNull();
      }
    }
  });

  it('userscoreScope = overall: источник не публикует его по платформам', () => {
    const game = parse('game-elden-ring.html', 'elden-ring');
    for (const platform of game.platforms) {
      // 'overall' — штатное состояние, а не 'overall_fallback' (деградация)
      expect(platform.userscoreScope).toBe('overall');
    }
  });

  it('общий Userscore не разносится по платформам', () => {
    const game = parseGameDetail(load('game-elden-ring.html'), {
      sourceSlug: 'elden-ring',
      url: '/game/elden-ring/',
      userscoreOverall: 8.4,
    });

    expect(game.userscoreOverall).toBe(8.4);
    for (const platform of game.platforms) {
      expect(platform.userscore).toBeNull();
    }
  });
});

describe('Деградация: overall_fallback отличается от overall', () => {
  it('платформы только из JSON-LD помечаются overall_fallback', () => {
    // DOM-карточек с оценками нет — связь установить не удалось
    const html = `
      <div data-testid="hero-title"><h1>JSON-LD Only</h1></div>
      <script type="application/ld+json">
        {"@type":"VideoGame","name":"JSON-LD Only",
         "gamePlatform":["PC","PlayStation 5"]}
      </script>`;

    const game = parseGameDetail(html, { sourceSlug: 'j', url: '/game/j/' });

    expect(game.platforms).toHaveLength(2);
    for (const platform of game.platforms) {
      // Деградация должна быть видна в данных, а не замаскирована
      expect(platform.metascoreScope).toBe('overall_fallback');
      expect(platform.metascore).toBeNull();
      // Userscore при этом остаётся штатным overall
      expect(platform.userscoreScope).toBe('overall');
    }
  });
});

describe('Основные поля', () => {
  it('извлекает название, описание, обложку', () => {
    const game = parse('game-elden-ring.html', 'elden-ring');

    expect(game.title).toBe('Elden Ring');
    expect(game.description).toBeTruthy();
    expect(game.coverImageUrl).toMatch(/^https:\/\//);
  });

  it('формирует canonical URL и сохраняет source/slug', () => {
    const game = parse('game-elden-ring.html', 'elden-ring');

    expect(game.source).toBe('metacritic');
    expect(game.sourceSlug).toBe('elden-ring');
    expect(game.canonicalUrl).toContain('/game/elden-ring/');
  });

  it('извлекает жанры и дату релиза', () => {
    const game = parse('game-elden-ring.html', 'elden-ring');

    expect(game.genres.length).toBeGreaterThan(0);
    expect(game.releaseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('фиксирует версию парсера', () => {
    const game = parse('game-elden-ring.html', 'elden-ring');
    expect(game.parserVersion).toBe('metacritic-detail-v1');
  });

  it('отсутствие описания не ломает разбор', () => {
    const html = `
      <div data-testid="hero-title"><h1>No Description</h1></div>`;
    const game = parseGameDetail(html, { sourceSlug: 'nd', url: '/game/nd/' });

    expect(game.title).toBe('No Description');
    expect(game.description).toBeNull();
  });

  it('отсутствие видео не ломает разбор', () => {
    const html = `<div data-testid="hero-title"><h1>No Video</h1></div>`;
    const game = parseGameDetail(html, { sourceSlug: 'nv', url: '/game/nv/' });

    expect(game.videoUrl).toBeNull();
  });

  it('отсутствие оценок не ломает разбор', () => {
    const html = `<div data-testid="hero-title"><h1>No Scores</h1></div>`;
    const game = parseGameDetail(html, { sourceSlug: 'ns', url: '/game/ns/' });

    expect(game.metascoreOverall).toBeNull();
    expect(game.userscoreOverall).toBeNull();
    expect(game.platforms).toHaveLength(0);
  });

  it('извлекает ссылку на видео из JSON-LD', () => {
    const html = `
      <div data-testid="hero-title"><h1>With Trailer</h1></div>
      <script type="application/ld+json">
        {"@type":"VideoGame","name":"With Trailer",
         "trailer":{"@type":"VideoObject","contentUrl":"https://cdn.example/t.mp4"}}
      </script>`;

    const game = parseGameDetail(html, { sourceSlug: 'wt', url: '/game/wt/' });
    expect(game.videoUrl).toBe('https://cdn.example/t.mp4');
  });
});

describe('НЕГАТИВНЫЕ: неизвестная структура не даёт "успех с пустыми полями"', () => {
  it('страница без названия — ошибка разбора', () => {
    const html = '<div class="unknown-layout"><p>Ничего похожего</p></div>';

    expect(() => parseGameDetail(html, { sourceSlug: 'x', url: '/game/x/' })).toThrow(
      ParseError,
    );
  });

  it('пустой HTML — ошибка разбора', () => {
    expect(() => parseGameDetail('', { sourceSlug: 'x', url: '/game/x/' })).toThrow(
      ParseError,
    );
  });

  it('битый JSON-LD не роняет разбор, если название есть в DOM', () => {
    const html = `
      <div data-testid="hero-title"><h1>Broken LD</h1></div>
      <script type="application/ld+json">{ это не json }</script>`;

    const game = parseGameDetail(html, { sourceSlug: 'bl', url: '/game/bl/' });
    expect(game.title).toBe('Broken LD');
  });
});
