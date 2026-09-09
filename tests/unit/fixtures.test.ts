import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Проверка целостности golden fixtures.
 *
 * Парсеры ещё не реализованы (Фаза 1). Эти тесты гарантируют, что фикстуры
 * действительно содержат поля, ради которых они сохранены, — иначе к моменту
 * написания парсеров можно обнаружить, что тестировать не на чем.
 *
 * Сеть здесь не используется: только чтение файлов.
 */

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'metacritic',
);

function load(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

/** Извлекает JSON-LD блок типа VideoGame — та же логика, что будет в парсере. */
function extractVideoGameLd(html: string): Record<string, unknown> | null {
  const matches = [
    ...html.matchAll(
      /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ];
  for (const m of matches) {
    try {
      const parsed: unknown = JSON.parse((m[1] ?? '').trim());
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) {
        if (
          typeof item === 'object' &&
          item !== null &&
          (item as Record<string, unknown>)['@type'] === 'VideoGame'
        ) {
          return item as Record<string, unknown>;
        }
      }
    } catch {
      // Невалидный блок пропускаем — на странице их может быть несколько
    }
  }
  return null;
}

describe('Фикстуры страниц игр', () => {
  it('elden-ring содержит developer в виде ссылки на компанию', () => {
    const html = load('game-elden-ring.html');
    expect(html).toContain('data-testid="hero-summary-developer"');
    expect(html).toContain('/company/from-software/');
    expect(html).toContain('From Software');
  });

  it('the-blood-of-dawnwalker содержит developer простым текстом (вторая форма)', () => {
    const html = load('game-developer-plain-text.html');
    expect(html).toContain('data-testid="hero-summary-developer"');
    expect(html).toContain('Rebel Wolves');
    // Ключевое отличие: ссылки на компанию нет
    const block = html.slice(html.indexOf('hero-summary-developer'));
    expect(block.slice(0, 500)).not.toContain('/company/');
  });

  it('синтетическая фикстура содержит пустой блок developer', () => {
    const html = load('game-developer-missing.html');
    expect(html).toContain('data-testid="hero-summary-developer"');
    expect(html).toContain('Developer:');
    // Издатель присутствует — парсер не должен подставить его как developer
    expect(html).toContain('Some Publisher Ltd');
  });

  it('elden-ring содержит несколько платформ с РАЗНЫМИ оценками', () => {
    const html = load('game-elden-ring.html');
    const platforms = [...html.matchAll(/title="(PC|PlayStation \d|Xbox [^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(new Set(platforms).size).toBeGreaterThanOrEqual(3);

    const scores = [...html.matchAll(/title="Metascore (\d{1,3}) out of 100"/g)].map((m) =>
      Number(m[1]),
    );
    // Различие оценок — доказательство привязки к платформе (ADR-0008)
    expect(new Set(scores).size).toBeGreaterThan(1);
  });

  it('witcher-3 содержит несколько платформ и платформу со статусом tbd', () => {
    const html = load('game-witcher-3.html');
    const platforms = [...html.matchAll(/title="(PC|PlayStation \d|Xbox [^"]+|Nintendo [^"]+)"/g)];
    expect(platforms.length).toBeGreaterThanOrEqual(3);
    // tbd = платформа известна, оценки ещё нет
    expect(html).toContain('Metascore tbd');
  });

  it('JSON-LD извлекается и содержит требуемые поля', () => {
    const ld = extractVideoGameLd(load('game-elden-ring.html'));
    expect(ld).not.toBeNull();
    expect(ld?.name).toBe('Elden Ring');
    expect(ld?.description).toBeTruthy();
    expect(ld?.gamePlatform).toBeDefined();
    expect(ld?.publisher).toBeDefined();
  });

  it('JSON-LD отдаёт publisher, а не developer (обоснование ADR-0003)', () => {
    const ld = extractVideoGameLd(load('game-elden-ring.html'));
    const publishers = JSON.stringify(ld?.publisher ?? []);
    // Список смешивает издателя и разработчика — использовать как developer нельзя
    expect(publishers).toContain('Bandai Namco');
    expect(ld?.developer).toBeUndefined();
  });
});

describe('Фикстуры отзывов', () => {
  it('критики: агрегированная оценка и карточки отзывов', () => {
    const html = load('reviews-critic-elden-ring.html');
    expect(html).toContain('data-testid="review-card"');

    const cards = [...html.matchAll(/data-testid="review-card"/g)];
    expect(cards.length).toBeGreaterThanOrEqual(3);

    // Текст отзыва — вход для LLM-резюме
    expect(html).toContain('data-testid="review-quote-text"');
  });

  it('пользователи: содержит ОБЩИЙ Userscore 8.4', () => {
    const html = load('reviews-user-elden-ring.html');
    // Общий по игре, не по платформе — основание для overall_fallback
    expect(html).toContain('8.4');
    expect(html).toContain('data-testid="review-card"');
  });

  it('отзывы содержат платформу — Userscore можно было бы вычислить (но не делаем)', () => {
    const html = load('reviews-user-elden-ring.html');
    expect(html).toContain('data-testid="review-platform"');
  });
});

describe('Фикстуры листингов', () => {
  it('New Releases содержит 20 карточек (размер батча по ТЗ)', () => {
    const html = load('list-new-releases.html');
    const slugs = new Set([...html.matchAll(/href="\/game\/([a-z0-9-]+)\//g)].map((m) => m[1]));

    expect(slugs.size).toBe(20);
    // Главная страница использует ИНУЮ разметку карточек, чем browse:
    // здесь product-card, там — <a> с product-title внутри. Поэтому
    // парсера два, и фикстуры листингов тоже две.
    expect(html).toContain('data-testid="product-card"');
  });

  it('browse-листинг использует иную разметку, чем главная страница', () => {
    const html = load('list-browse-page1.html');

    // Карточка browse — ссылка на игру, содержащая product-title
    expect(html).toContain('data-testid="product-title"');
    // Разметки главной здесь нет: единый парсер вернул бы пустой список
    expect(html).not.toContain('data-testid="product-card"');
  });

  it('обе страницы browse содержат карточки', () => {
    for (const file of ['list-browse-page1.html', 'list-browse-page2.html']) {
      const html = load(file);
      const slugs = new Set(
        [...html.matchAll(/href="\/game\/([a-z0-9-]+)\//g)].map((m) => m[1]),
      );
      expect(slugs.size, `${file}: мало карточек`).toBeGreaterThan(10);
    }
  });

  it('страницы browse ПЕРЕСЕКАЮТСЯ — листинг дрейфует (ADR-0002)', () => {
    const slugsOf = (file: string) =>
      new Set([...load(file).matchAll(/href="\/game\/([a-z0-9-]+)\//g)].map((m) => m[1]));

    const p1 = slugsOf('list-browse-page1.html');
    const p2 = slugsOf('list-browse-page2.html');
    const overlap = [...p1].filter((s) => p2.has(s));

    // Фикстуры сняты с интервалом ~1.3 с, и часть игр попала на обе страницы:
    // список сортируется по дате релиза, новые записи вставляются сверху.
    // Именно поэтому источник истины — реестр заявок, а не номер страницы.
    expect(overlap.length).toBeGreaterThan(0);
    expect(overlap.length).toBeLessThan(p1.size);
  });
});

describe('Гигиена фикстур', () => {
  const files = [
    'game-elden-ring.html',
    'game-witcher-3.html',
    'game-developer-plain-text.html',
    'game-developer-missing.html',
    'reviews-critic-elden-ring.html',
    'reviews-user-elden-ring.html',
    'list-new-releases.html',
    'list-browse-page1.html',
    'list-browse-page2.html',
  ];

  it('каждая фикстура документирует источник и дату', () => {
    for (const file of files) {
      const head = load(file).slice(0, 400);
      expect(head, `${file}: нет заголовка FIXTURE`).toContain('FIXTURE');
      expect(head, `${file}: нет даты получения`).toContain('2026-09-07');
    }
  });

  it('фикстуры компактны — сохранено только нужное', () => {
    // Порог поднят после перехода на сохранение ЦЕЛЫХ DOM-узлов: обрезка по
    // символам ломала структуру (пустые h3, потерянные img), и парсеры на таких
    // фикстурах были непроверяемы. Корректность важнее пары десятков килобайт.
    // Исходные страницы весили 300–950 КБ, так что сжатие всё равно кратное.
    for (const file of files) {
      const sizeKb = Buffer.byteLength(load(file), 'utf8') / 1024;
      expect(sizeKb, `${file} слишком велика: ${sizeKb.toFixed(1)} КБ`).toBeLessThan(150);
    }
  });

  it('из фикстур вырезаны стили и посторонние скрипты', () => {
    for (const file of files) {
      const html = load(file);
      expect(html, `${file}: остались <style>`).not.toMatch(/<style[^>]*>/i);
      // Допускается только JSON-LD
      const scripts = [...html.matchAll(/<script([^>]*)>/gi)].map((m) => m[1] ?? '');
      for (const attrs of scripts) {
        expect(attrs, `${file}: посторонний <script>`).toContain('application/ld+json');
      }
    }
  });

  it('фикстуры не содержат секретов', () => {
    const forbidden = [/api[_-]?key/i, /authorization:/i, /bearer\s+[A-Za-z0-9._-]{20,}/i];
    for (const file of files) {
      const html = load(file);
      for (const pattern of forbidden) {
        expect(html, `${file}: подозрение на секрет ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
