import * as cheerio from 'cheerio';
import type { CheerioAPI, Cheerio } from 'cheerio';
import type { Element } from 'domhandler';
import { ParseError } from '../../domain/ingestion-errors.js';
import type {
  ListingSection,
  NormalizedListingItem,
  NormalizedListingPage,
} from '../../domain/catalog-source.js';
import {
  absoluteUrl,
  cleanText,
  extractSlug,
  parseReleaseDate,
  toCanonicalUrl,
} from './normalize.js';

/**
 * Парсеры листингов Metacritic.
 *
 * Разметка двух источников РАЗЛИЧАЕТСЯ — это установлено при подготовке
 * фикстур, поэтому парсера два:
 *
 *   /game/                    -> карточка = [data-testid="product-card"]
 *   /browse/.../new/          -> карточка = <a href="/game/..."> с product-title внутри
 *
 * Единый парсер по одному маркеру молча вернул бы пустой список для второго
 * источника — тот самый «успех с пустым результатом», который запрещён.
 */

/** Порог: если разобрать не удалось столь большую долю карточек — считаем разметку сменившейся. */
const MAX_SKIP_RATIO = 0.5;

interface ParsedCard {
  readonly item: NormalizedListingItem | null;
}

function buildItem(
  slug: string,
  title: string | null,
  position: number,
  coverImageUrl: string | null,
  releaseDate: string | null,
  platform: string | null,
): NormalizedListingItem | null {
  // Без slug и заголовка карточка бесполезна — считаем её неразобранной.
  if (!title) return null;

  return {
    source: 'metacritic',
    sourceSlug: slug,
    title,
    canonicalUrl: toCanonicalUrl(slug),
    coverImageUrl,
    position,
    releaseDate,
    platform,
  };
}

/** Достаёт URL обложки, учитывая lazy-loading через data-src. */
function extractImage($: CheerioAPI, scope: Cheerio<Element>): string | null {
  const img = scope.find('img').first();
  if (img.length === 0) return null;

  const candidate =
    img.attr('src') ?? img.attr('data-src') ?? img.attr('data-lazy-src') ?? undefined;
  return absoluteUrl(candidate);
}

/**
 * Общая часть: сборка страницы и защита от «успеха с пустым результатом».
 */
function assemblePage(
  section: ListingSection,
  page: number,
  parsed: readonly ParsedCard[],
  url: string,
): NormalizedListingPage {
  const items: NormalizedListingItem[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const { item } of parsed) {
    if (!item) {
      skipped += 1;
      continue;
    }
    // Дубли внутри одной страницы отбрасываются: сохраняется первое вхождение,
    // порядок которого ближе к порядку источника.
    if (seen.has(item.sourceSlug)) continue;
    seen.add(item.sourceSlug);
    items.push(item);
  }

  if (parsed.length === 0) {
    throw new ParseError(
      'На странице листинга не найдено ни одной карточки — вероятно, изменилась разметка',
      { url, detail: `section=${section}, page=${page}` },
    );
  }

  if (skipped > 0 && skipped / parsed.length > MAX_SKIP_RATIO) {
    throw new ParseError(
      `Не удалось разобрать ${skipped} из ${parsed.length} карточек — вероятно, изменилась разметка`,
      { url, detail: `section=${section}, page=${page}` },
    );
  }

  return { section, page, items, skipped };
}

/**
 * Парсер раздела New Releases на главной странице игр.
 */
export function parseNewReleasesListing(
  html: string,
  options: { url: string; limit?: number } = { url: '/game/' },
): NormalizedListingPage {
  const $ = cheerio.load(html);
  const cards = $('[data-testid="product-card"]');

  const parsed: ParsedCard[] = [];
  cards.each((index, element) => {
    if (options.limit !== undefined && parsed.length >= options.limit) return;

    const card = $(element);
    const href = card.find('a[href^="/game/"]').first().attr('href');
    const slug = extractSlug(href);
    if (!slug) {
      parsed.push({ item: null });
      return;
    }

    const title =
      cleanText(card.find('h3').first().text()) ??
      cleanText(card.find('[data-title]').first().attr('data-title'));

    parsed.push({
      item: buildItem(
        slug,
        title,
        parsed.length,
        extractImage($, card),
        parseReleaseDate(findDateText($, card)),
        null,
      ),
    });
  });

  return assemblePage('new_releases', 1, parsed, options.url);
}

/**
 * Парсер листинга See All (browse).
 *
 * Поддерживает пагинацию: номер страницы приходит извне и лишь помечает
 * результат — источником истины о том, что уже обработано, остаётся реестр
 * заявок (ADR-0002).
 */
export function parseBrowseListing(
  html: string,
  options: { url: string; page?: number; limit?: number },
): NormalizedListingPage {
  const $ = cheerio.load(html);
  const page = options.page ?? 1;

  // Карточка browse — ссылка на игру, содержащая заголовок.
  const cards = $('a[href^="/game/"]').filter(
    (_, element) => $(element).find('[data-testid="product-title"]').length > 0,
  );

  const parsed: ParsedCard[] = [];
  cards.each((_, element) => {
    if (options.limit !== undefined && parsed.length >= options.limit) return;

    const card = $(element);
    const slug = extractSlug(card.attr('href'));
    if (!slug) {
      parsed.push({ item: null });
      return;
    }

    const title = cleanText(card.find('[data-testid="product-title"]').first().text());

    parsed.push({
      item: buildItem(
        slug,
        title,
        parsed.length,
        extractImage($, card),
        parseReleaseDate(findDateText($, card)),
        null,
      ),
    });
  });

  return assemblePage('browse_all_new', page, parsed, options.url);
}

/** Ищет в карточке текст, похожий на дату релиза ("Sep 7, 2026"). */
function findDateText($: CheerioAPI, scope: Cheerio<Element>): string | null {
  let found: string | null = null;

  scope.find('span, div, p').each((_, element) => {
    if (found) return;
    const text = cleanText($(element).text());
    if (text && /^[A-Za-z]{3}\s+\d{1,2},\s*\d{4}$/.test(text)) {
      found = text;
    }
  });

  return found;
}
