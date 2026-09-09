import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseBrowseListing,
  parseNewReleasesListing,
} from '../../src/modules/ingestion/infrastructure/parsers/listing-parser.js';
import { ParseError } from '../../src/modules/ingestion/domain/ingestion-errors.js';

/** Тесты работают только на фикстурах: сеть не используется. */

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'metacritic',
);

const load = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

describe('parseNewReleasesListing — источник A (/game/)', () => {
  const html = load('list-new-releases.html');

  it('извлекает карточки раздела New Releases', () => {
    const page = parseNewReleasesListing(html, { url: '/game/' });

    expect(page.section).toBe('new_releases');
    expect(page.page).toBe(1);
    expect(page.items.length).toBeGreaterThan(0);
  });

  it('нормализует обязательные поля элемента', () => {
    const [first] = parseNewReleasesListing(html, { url: '/game/' }).items;

    expect(first).toBeDefined();
    expect(first!.source).toBe('metacritic');
    expect(first!.sourceSlug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(first!.title.length).toBeGreaterThan(0);
    expect(first!.canonicalUrl).toBe(
      `https://www.metacritic.com/game/${first!.sourceSlug}/`,
    );
  });

  it('сохраняет порядок карточек источника', () => {
    const { items } = parseNewReleasesListing(html, { url: '/game/' });
    const positions = items.map((item) => item.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions[0]).toBe(0);
  });

  it('не возвращает дублирующихся слагов', () => {
    const { items } = parseNewReleasesListing(html, { url: '/game/' });
    const slugs = items.map((item) => item.sourceSlug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('соблюдает ограничение limit', () => {
    const page = parseNewReleasesListing(html, { url: '/game/', limit: 5 });
    expect(page.items).toHaveLength(5);
  });

  it('извлекает обложку, если она есть в разметке', () => {
    const { items } = parseNewReleasesListing(html, { url: '/game/' });
    const withCover = items.filter((item) => item.coverImageUrl !== null);

    expect(withCover.length).toBeGreaterThan(0);
    for (const item of withCover) {
      expect(item.coverImageUrl).toMatch(/^https:\/\//);
    }
  });
});

describe('parseBrowseListing — источник B (/browse/.../new/)', () => {
  const page1 = load('list-browse-page1.html');
  const page2 = load('list-browse-page2.html');

  it('извлекает карточки листинга See All', () => {
    const page = parseBrowseListing(page1, { url: '/browse/', page: 1 });

    expect(page.section).toBe('browse_all_new');
    expect(page.items.length).toBeGreaterThan(0);
  });

  it('поддерживает пагинацию: номер страницы отражается в результате', () => {
    const parsed = parseBrowseListing(page2, { url: '/browse/?page=2', page: 2 });
    expect(parsed.page).toBe(2);
    expect(parsed.items.length).toBeGreaterThan(0);
  });

  it('страницы могут пересекаться — листинг дрейфует между запросами (ADR-0002)', () => {
    const a = parseBrowseListing(page1, { url: '/browse/', page: 1 });
    const b = parseBrowseListing(page2, { url: '/browse/?page=2', page: 2 });

    const slugsA = new Set(a.items.map((item) => item.sourceSlug));
    const overlap = b.items.filter((item) => slugsA.has(item.sourceSlug));

    // Фикстуры сняты с интервалом ~1.3 с, и за это время список сдвинулся:
    // 5 игр попали на обе страницы. Это подтверждает, что номер страницы —
    // лишь подсказка, а защиту от повторов даёт реестр заявок.
    // Парсер обязан вернуть данные как есть, не пытаясь дедуплицировать
    // между страницами — это ответственность оркестрации.
    expect(a.items.length).toBeGreaterThan(0);
    expect(b.items.length).toBeGreaterThan(0);
    expect(overlap.length).toBeLessThan(a.items.length);
  });

  it('внутри ОДНОЙ страницы дублей нет', () => {
    for (const [html, page] of [
      [page1, 1],
      [page2, 2],
    ] as const) {
      const parsed = parseBrowseListing(html, { url: '/browse/', page });
      const slugs = parsed.items.map((item) => item.sourceSlug);
      expect(new Set(slugs).size).toBe(slugs.length);
    }
  });

  it('использует разметку, отличную от главной страницы', () => {
    // Парсер главной на browse-разметке не найдёт карточек и обязан упасть,
    // а не вернуть пустой успешный результат.
    expect(() => parseNewReleasesListing(page1, { url: '/browse/' })).toThrow(ParseError);
  });

  it('нормализует canonical URL', () => {
    const { items } = parseBrowseListing(page1, { url: '/browse/', page: 1 });
    for (const item of items) {
      expect(item.canonicalUrl).toBe(
        `https://www.metacritic.com/game/${item.sourceSlug}/`,
      );
    }
  });
});

describe('Устойчивость парсеров листингов', () => {
  it('пустой HTML — ошибка, а не успех с пустым списком', () => {
    expect(() => parseNewReleasesListing('<html><body></body></html>', { url: '/game/' })).toThrow(
      ParseError,
    );
    expect(() => parseBrowseListing('<html><body></body></html>', { url: '/browse/' })).toThrow(
      ParseError,
    );
  });

  it('неизвестная структура не превращается в успешный результат', () => {
    const html = '<div class="totally-different"><span>Nothing here</span></div>';
    expect(() => parseNewReleasesListing(html, { url: '/game/' })).toThrow(ParseError);
  });

  it('карточка без ссылки пропускается, остальные разбираются', () => {
    const html = `
      <div id="fx-list">
        <div data-testid="product-card"><h3>Без ссылки</h3></div>
        <div data-testid="product-card">
          <a href="/game/valid-game/"><h3>Валидная игра</h3></a>
        </div>
        <div data-testid="product-card">
          <a href="/game/second-game/"><h3>Вторая игра</h3></a>
        </div>
      </div>`;

    const page = parseNewReleasesListing(html, { url: '/game/' });
    expect(page.items).toHaveLength(2);
    expect(page.skipped).toBe(1);
  });

  it('слишком много неразобранных карточек — ошибка разметки', () => {
    // 3 из 4 битых: доля выше порога, значит разметка изменилась
    const html = `
      <div id="fx-list">
        <div data-testid="product-card"><h3>Битая 1</h3></div>
        <div data-testid="product-card"><h3>Битая 2</h3></div>
        <div data-testid="product-card"><h3>Битая 3</h3></div>
        <div data-testid="product-card"><a href="/game/ok/"><h3>OK</h3></a></div>
      </div>`;

    expect(() => parseNewReleasesListing(html, { url: '/game/' })).toThrow(
      /не удалось разобрать/i,
    );
  });

  it('карточка без названия считается неразобранной', () => {
    const html = `
      <div id="fx-list">
        <div data-testid="product-card"><a href="/game/no-title/"></a></div>
        <div data-testid="product-card"><a href="/game/with-title/"><h3>Есть</h3></a></div>
      </div>`;

    const page = parseNewReleasesListing(html, { url: '/game/' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.sourceSlug).toBe('with-title');
    expect(page.skipped).toBe(1);
  });

  it('дублирующийся slug сохраняется один раз', () => {
    const html = `
      <div id="fx-list">
        <div data-testid="product-card"><a href="/game/dup/"><h3>Первая</h3></a></div>
        <div data-testid="product-card"><a href="/game/dup/"><h3>Дубль</h3></a></div>
        <div data-testid="product-card"><a href="/game/other/"><h3>Другая</h3></a></div>
      </div>`;

    const page = parseNewReleasesListing(html, { url: '/game/' });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]!.title).toBe('Первая');
  });

  it('отсутствие обложки не мешает разбору', () => {
    const html = `
      <div id="fx-list">
        <div data-testid="product-card"><a href="/game/no-image/"><h3>Без картинки</h3></a></div>
      </div>`;

    const page = parseNewReleasesListing(html, { url: '/game/' });
    expect(page.items[0]!.coverImageUrl).toBeNull();
    expect(page.items[0]!.title).toBe('Без картинки');
  });

  it('дата релиза извлекается, если присутствует', () => {
    const html = `
      <div id="fx-list">
        <div data-testid="product-card">
          <a href="/game/dated/"><h3>С датой</h3></a>
          <span>Sep 7, 2026</span>
        </div>
      </div>`;

    const page = parseNewReleasesListing(html, { url: '/game/' });
    expect(page.items[0]!.releaseDate).toBe('2026-09-07');
  });

  it('будущая дата релиза допустима', () => {
    const html = `
      <div id="fx-list">
        <div data-testid="product-card">
          <a href="/game/future/"><h3>Будущая</h3></a>
          <span>Dec 31, 2030</span>
        </div>
      </div>`;

    const page = parseNewReleasesListing(html, { url: '/game/' });
    expect(page.items[0]!.releaseDate).toBe('2030-12-31');
  });
});
