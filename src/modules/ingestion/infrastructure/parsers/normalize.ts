/**
 * Утилиты нормализации значений, извлечённых со страниц источника.
 *
 * Задача слоя — превратить представление источника (текст, атрибуты, форматы
 * дат) в доменные значения. Специфика HTML сюда не проникает.
 */

const BASE_URL = 'https://www.metacritic.com';

/** Извлекает slug из ссылки вида /game/elden-ring/ */
export function extractSlug(href: string | undefined): string | null {
  if (!href) return null;
  const match = /\/game\/([a-z0-9][a-z0-9-]*)\/?(?:[?#]|$)/i.exec(href);
  return match?.[1]?.toLowerCase() ?? null;
}

export function toCanonicalUrl(slug: string): string {
  return `${BASE_URL}/game/${slug}/`;
}

export function absoluteUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('/')) return `${BASE_URL}${trimmed}`;
  return null;
}

export function cleanText(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Разбирает Metascore.
 * "tbd" означает «оценки ещё нет» — это допустимое состояние, а не ошибка.
 */
export function parseMetascore(value: string | undefined | null): number | null {
  const text = cleanText(value)?.toLowerCase();
  if (!text || text === 'tbd') return null;

  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  return parsed;
}

/** Разбирает Userscore по 10-балльной шкале. */
export function parseUserscore(value: string | undefined | null): number | null {
  const text = cleanText(value)?.toLowerCase();
  if (!text || text === 'tbd') return null;

  const parsed = Number.parseFloat(text);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10) return null;
  return Math.round(parsed * 10) / 10;
}

export function parseCount(value: string | undefined | null): number | null {
  const text = cleanText(value);
  if (!text) return null;
  const digits = text.replace(/[^\d]/g, '');
  if (digits.length === 0) return null;
  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Приводит дату к ISO YYYY-MM-DD.
 * Поддерживает форматы "Sep 7, 2026" и уже готовый ISO.
 * Даты в будущем допустимы — на Metacritic это норма.
 */
export function parseReleaseDate(value: string | undefined | null): string | null {
  const text = cleanText(value);
  if (!text) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const named = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})$/.exec(text);
  if (named) {
    const month = MONTHS[named[1]!.toLowerCase()];
    if (!month) return null;
    return `${named[3]}-${month}-${named[2]!.padStart(2, '0')}`;
  }

  return null;
}

/**
 * Нормализует название платформы в стабильный код.
 * "PlayStation 5" -> "playstation-5"
 */
export function normalizePlatformSlug(name: string | undefined | null): string | null {
  const text = cleanText(name);
  if (!text) return null;

  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug.length > 0 ? slug : null;
}

/** Извлекает первое число из строк вида "Based on 63 Critic Reviews". */
export function parseReviewCount(value: string | undefined | null): number | null {
  const text = cleanText(value);
  if (!text) return null;
  const match = /Based on\s+([\d,]+)/i.exec(text);
  return match ? parseCount(match[1]) : null;
}
