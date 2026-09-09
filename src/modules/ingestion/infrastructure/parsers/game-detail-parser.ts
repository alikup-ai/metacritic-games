import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { ParseError } from '../../domain/ingestion-errors.js';
import type {
  NormalizedGame,
  NormalizedPlatformScore,
  UserscoreStatus,
} from '../../domain/catalog-source.js';
import type { DeveloperStatus } from '../../../catalog/domain/game.js';
import {
  absoluteUrl,
  cleanText,
  normalizePlatformSlug,
  parseMetascore,
  parseReleaseDate,
  parseReviewCount,
  parseUserscore,
  toCanonicalUrl,
} from './normalize.js';

/**
 * Парсер карточки игры.
 *
 * Стратегия: JSON-LD как основной источник (schema.org — контракт стабильнее
 * CSS-классов), DOM как дополнение для полей, которых в JSON-LD нет.
 *
 * Ключевые инварианты:
 * - developer берётся ТОЛЬКО из DOM-блока разработчика; publisher из JSON-LD
 *   никогда не используется как запасное значение (ADR-0003);
 * - Userscore не приписывается платформе: Metacritic не публикует его в разрезе
 *   платформ, поэтому scope = 'overall' (ADR-0008).
 */

export const PARSER_VERSION = 'metacritic-detail-v1';

interface JsonLdVideoGame {
  readonly name?: string;
  readonly description?: string;
  readonly image?: string | { contentUrl?: string; url?: string };
  readonly genre?: string | string[];
  readonly datePublished?: string;
  readonly gamePlatform?: string | string[];
  readonly publisher?: unknown;
  readonly trailer?: unknown;
  readonly aggregateRating?: unknown;
  readonly url?: string;
}

function extractJsonLd($: CheerioAPI): JsonLdVideoGame | null {
  let found: JsonLdVideoGame | null = null;

  $('script[type="application/ld+json"]').each((_, element) => {
    if (found) return;

    const raw = $(element).contents().text().trim();
    if (raw.length === 0) return;

    try {
      const parsed: unknown = JSON.parse(raw);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const candidate of candidates) {
        if (
          typeof candidate === 'object' &&
          candidate !== null &&
          (candidate as Record<string, unknown>)['@type'] === 'VideoGame'
        ) {
          found = candidate as JsonLdVideoGame;
          return;
        }
      }
    } catch {
      // Невалидный блок пропускаем: на странице их может быть несколько,
      // и один сломанный не должен ронять разбор.
    }
  });

  return found;
}

function toStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    const cleaned = cleanText(value);
    return cleaned ? [cleaned] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => toStringArray(item));
  }
  if (typeof value === 'object' && value !== null) {
    const name = (value as { name?: unknown }).name;
    if (typeof name === 'string') {
      const cleaned = cleanText(name);
      return cleaned ? [cleaned] : [];
    }
  }
  return [];
}

/**
 * Извлекает разработчика.
 *
 * Обе формы разметки реальны и обязаны поддерживаться:
 *   <a href="/company/...">From Software</a>   — ссылка
 *   <span class="text-gray-800">Rebel Wolves</span> — простой текст
 *
 * Поиск только по href терял бы разработчика у большинства новых игр.
 * При отсутствии значения возвращается 'unknown' — издатель НЕ подставляется.
 */
export function extractDeveloper($: CheerioAPI): {
  developer: string | null;
  developerStatus: DeveloperStatus;
} {
  const block = $('[data-testid="hero-summary-developer"]').first();
  if (block.length === 0) {
    return { developer: null, developerStatus: 'unknown' };
  }

  // Форма A: ссылка на страницу компании
  const linked = cleanText(block.find('a[href^="/company/"]').first().text());
  if (linked) return { developer: linked, developerStatus: 'resolved' };

  // Форма B: простой текст. Подпись "Developer:" отбрасывается.
  let plain: string | null = null;
  block.find('span, a').each((_, element) => {
    if (plain) return;
    const text = cleanText($(element).text());
    if (!text) return;
    if (/^developer:?$/i.test(text)) return;
    plain = text;
  });

  if (plain) return { developer: plain, developerStatus: 'resolved' };

  // Запасной путь: весь текст блока без подписи
  const whole = cleanText(block.text())?.replace(/^developer:?\s*/i, '') ?? null;
  if (whole && whole.length > 0) {
    return { developer: whole, developerStatus: 'resolved' };
  }

  return { developer: null, developerStatus: 'unknown' };
}

/**
 * Извлекает оценки по платформам.
 *
 * Metascore привязывается к платформе, поскольку название платформы и балл
 * находятся в одном контейнере (доказано исследованием OQ-18).
 * Userscore в разрезе платформ Metacritic не публикует, поэтому он не
 * распределяется по платформам и не вычисляется самостоятельно.
 */
export function extractPlatforms($: CheerioAPI): NormalizedPlatformScore[] {
  const result: NormalizedPlatformScore[] = [];
  const seen = new Set<string>();

  $('.product-score-card').each((_, element) => {
    const card = $(element);

    // Имя платформы — в атрибуте title иконки; отсеиваем title со счётом.
    let platformName: string | null = null;
    card.find('[title]').each((_i, node) => {
      if (platformName) return;
      const title = cleanText($(node).attr('title'));
      if (!title) return;
      if (/^metascore/i.test(title) || /^user score/i.test(title)) return;
      platformName = title;
    });

    if (!platformName) return;

    const slug = normalizePlatformSlug(platformName);
    if (!slug || seen.has(slug)) return;
    seen.add(slug);

    // Балл берём из title вида "Metascore 94 out of 100" — устойчивее текста.
    const scoreTitle = card.find('[title^="Metascore"]').first().attr('title') ?? '';
    const scoreMatch = /Metascore\s+(\d{1,3})\s+out of\s+100/i.exec(scoreTitle);
    const metascore = scoreMatch ? parseMetascore(scoreMatch[1]) : null;

    result.push({
      platform: slug,
      platformName,
      metascore,
      // Связь доказана исследованием; при неудаче разбора платформа
      // не попадёт в результат вовсе, а не получит ложный scope.
      metascoreScope: 'platform',
      // Metacritic не публикует Userscore по платформам — это штатное
      // состояние 'overall', а не деградация 'overall_fallback'.
      userscore: null,
      userscoreScope: 'overall',
      criticCount: parseReviewCount(card.text()),
    });
  });

  return result;
}

/** Извлекает платформы из JSON-LD, когда DOM-карточек нет. */
function platformsFromJsonLd(ld: JsonLdVideoGame | null): NormalizedPlatformScore[] {
  const names = toStringArray(ld?.gamePlatform);
  const seen = new Set<string>();
  const result: NormalizedPlatformScore[] = [];

  for (const name of names) {
    const slug = normalizePlatformSlug(name);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    result.push({
      platform: slug,
      platformName: name,
      metascore: null,
      // Платформа известна, но связать оценку с ней не удалось — это
      // деградация, и она должна быть видна в данных.
      metascoreScope: 'overall_fallback',
      userscore: null,
      userscoreScope: 'overall',
      criticCount: null,
    });
  }

  return result;
}

function extractTrailerUrl(ld: JsonLdVideoGame | null, $: CheerioAPI): string | null {
  const trailer = ld?.trailer;
  if (typeof trailer === 'object' && trailer !== null) {
    const candidate =
      (trailer as { contentUrl?: unknown }).contentUrl ??
      (trailer as { embedUrl?: unknown }).embedUrl ??
      (trailer as { url?: unknown }).url;
    if (typeof candidate === 'string') {
      const url = absoluteUrl(candidate);
      if (url) return url;
    }
  }

  const domVideo = $('video source').first().attr('src') ?? $('video').first().attr('src');
  return absoluteUrl(domVideo);
}

function extractImageUrl(ld: JsonLdVideoGame | null, $: CheerioAPI): string | null {
  const image = ld?.image;
  if (typeof image === 'string') {
    const url = absoluteUrl(image);
    if (url) return url;
  }
  if (typeof image === 'object' && image !== null) {
    const candidate = image.contentUrl ?? image.url;
    const url = absoluteUrl(candidate);
    if (url) return url;
  }

  const domImage =
    $('[data-testid="hero-summary"] img').first().attr('src') ?? $('img').first().attr('src');
  return absoluteUrl(domImage);
}

function extractOverallMetascore(ld: JsonLdVideoGame | null, $: CheerioAPI): number | null {
  const rating = ld?.aggregateRating;
  if (typeof rating === 'object' && rating !== null) {
    const value = (rating as { ratingValue?: unknown }).ratingValue;
    if (typeof value === 'number') return parseMetascore(String(value));
    if (typeof value === 'string') return parseMetascore(value);
  }

  const domTitle = $('[title^="Metascore"]').first().attr('title') ?? '';
  const match = /Metascore\s+(\d{1,3})\s+out of\s+100/i.exec(domTitle);
  return match ? parseMetascore(match[1]) : null;
}

export interface ParseGameDetailOptions {
  readonly sourceSlug: string;
  readonly url: string;
  /** Общий Userscore по игре, если он получен со страницы отзывов. */
  readonly userscoreOverall?: number | null;
  /** Исход попытки получить Userscore; по умолчанию — не запрашивался. */
  readonly userscoreStatus?: UserscoreStatus;
}

/**
 * Разбирает карточку игры в нормализованную структуру.
 *
 * Бросает ParseError, если не удалось получить обязательный минимум
 * (название). Возвращать «успех с пустыми полями» нельзя: такой результат
 * неотличим от игры без данных и молча испортил бы каталог.
 */
export function parseGameDetail(
  html: string,
  options: ParseGameDetailOptions,
): NormalizedGame {
  const $ = cheerio.load(html);
  const ld = extractJsonLd($);

  const title =
    cleanText(ld?.name) ??
    cleanText($('[data-testid="hero-title"]').first().text()) ??
    cleanText($('h1').first().text());

  if (!title) {
    throw new ParseError(
      'Не удалось определить название игры — структура страницы не распознана',
      { url: options.url, detail: `slug=${options.sourceSlug}` },
    );
  }

  const { developer, developerStatus } = extractDeveloper($);

  const domPlatforms = extractPlatforms($);
  const platforms = domPlatforms.length > 0 ? domPlatforms : platformsFromJsonLd(ld);

  return {
    source: 'metacritic',
    sourceSlug: options.sourceSlug,
    title,
    canonicalUrl: absoluteUrl(ld?.url) ?? toCanonicalUrl(options.sourceSlug),
    coverImageUrl: extractImageUrl(ld, $),

    developer,
    developerStatus,
    // Издатель хранится отдельно и никогда не подменяет разработчика.
    publishers: toStringArray(ld?.publisher),

    description: cleanText(ld?.description),
    videoUrl: extractTrailerUrl(ld, $),
    genres: toStringArray(ld?.genre),
    releaseDate: parseReleaseDate(ld?.datePublished),

    metascoreOverall: extractOverallMetascore(ld, $),
    userscoreOverall: options.userscoreOverall ?? null,
    userscoreStatus:
      options.userscoreStatus ??
      (options.userscoreOverall !== null && options.userscoreOverall !== undefined
        ? 'fetched'
        : 'disabled'),

    platforms,
    parserVersion: PARSER_VERSION,
  };
}

/**
 * Извлекает общий Userscore со страницы пользовательских отзывов.
 * Значение относится к игре целиком — по платформам оно не разносится.
 */
export function parseOverallUserscore(html: string): number | null {
  const $ = cheerio.load(html);

  const candidate = $('[class*="c-siteReviewScore"]').first().text();
  const parsed = parseUserscore(candidate);
  return parsed !== null && parsed <= 10 ? parsed : null;
}
