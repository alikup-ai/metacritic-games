import { ParseError } from '../../../ingestion/domain/ingestion-errors.js';
import type {
  NormalizedReview,
  NormalizedReviewPage,
  ReviewKind,
} from '../../domain/review.js';

/**
 * Парсеры ответа источника отзывов.
 *
 * Чистые функции: принимают разобранный JSON, возвращают нормализованные
 * структуры. Сети и состояния здесь нет — это делает их тестируемыми на
 * фикстурах.
 *
 * Ключевое правило: некорректная запись НЕ превращается в валидный пустой
 * отзыв. Она пропускается и считается в malformed, а нераспознанная
 * структура ответа даёт ошибку, а не «успех с пустым набором».
 */

/** Сырой ответ источника — форма подтверждена исследованием. */
interface RawReviewResponse {
  readonly data?: {
    readonly totalResults?: unknown;
    readonly items?: unknown;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

/** Текст отзыва сохраняется с переносами: они несут смысл для читателя. */
function reviewText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseScore(value: unknown, kind: ReviewKind): number | null {
  if (value === null || value === undefined) return null;

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;

  // Шкалы различаются: критики 0–100, пользователи 0–10.
  const max = kind === 'critic' ? 100 : 10;
  if (parsed < 0 || parsed > max) return null;

  return kind === 'critic' ? Math.round(parsed) : Math.round(parsed * 10) / 10;
}

/** Дата приводится к ISO YYYY-MM-DD; источник отдаёт её уже в этом виде. */
function parseDate(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function parseUrl(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;
  return text.startsWith('http://') || text.startsWith('https://') ? text : null;
}

function parseVersion(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

/**
 * Нормализует слаг платформы: "PlayStation 5" -> "playstation-5".
 * Совпадает с правилом каталога, чтобы ключи сходились между модулями.
 */
export function normalizePlatformSlug(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;

  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug.length > 0 ? slug : null;
}

function extractItems(payload: unknown, url: string): unknown[] {
  const response = asRecord(payload) as RawReviewResponse | null;
  const data = asRecord(response?.data);

  // Отсутствие блока data означает нераспознанную структуру, а не пустой
  // набор: молча вернуть [] было бы неотличимо от «отзывов нет».
  if (!data) {
    throw new ParseError('Ответ источника не содержит блока data', { url });
  }

  const items = data.items;
  if (!Array.isArray(items)) {
    throw new ParseError('Поле items отсутствует или не является массивом', { url });
  }

  return items;
}

function extractTotal(payload: unknown): number {
  const data = asRecord(asRecord(payload)?.data);
  const total = data?.totalResults;
  if (typeof total === 'number' && Number.isFinite(total) && total >= 0) return total;
  return 0;
}

/**
 * Разбирает страницу ПОЛЬЗОВАТЕЛЬСКИХ отзывов.
 *
 * Идентичность — внешний id (UUID). Запись без id считается некорректной:
 * без ключа её нельзя ни сохранить идемпотентно, ни сопоставить при
 * следующем обходе.
 */
export function parseUserReviewPage(
  payload: unknown,
  options: { url: string; platformSlug: string },
): NormalizedReviewPage {
  const items = extractItems(payload, options.url);

  const reviews: NormalizedReview[] = [];
  let malformed = 0;

  for (const raw of items) {
    const item = asRecord(raw);
    if (!item) {
      malformed += 1;
      continue;
    }

    const externalId = cleanText(item.id);
    const quote = reviewText(item.quote);

    // Без ключа или без текста отзыв бесполезен: сохранять «пустой валидный»
    // отзыв запрещено требованием.
    if (!externalId || !quote) {
      malformed += 1;
      continue;
    }

    reviews.push({
      identity: { kind: 'user', externalId },
      platformSlug: options.platformSlug,
      score: parseScore(item.score, 'user'),
      quote,
      author: cleanText(item.author),
      // Источник не публикует прямых ссылок на пользовательские отзывы
      reviewUrl: null,
      reviewDate: parseDate(item.date),
      sourceVersion: parseVersion(item.version),
      spoiler: typeof item.spoiler === 'boolean' ? item.spoiler : null,
    });
  }

  return {
    kind: 'user',
    platformSlug: options.platformSlug,
    reviews,
    totalAvailable: extractTotal(payload),
    malformed,
  };
}

/**
 * Разбирает страницу КРИТИЧЕСКИХ отзывов.
 *
 * У источника нет id, поэтому ключом служит слаг издания. Запись без него
 * считается некорректной: url для этой роли непригоден — проверено, что он
 * не уникален (91 из 93) и у части записей отсутствует.
 */
export function parseCriticReviewPage(
  payload: unknown,
  options: { url: string; platformSlug: string },
): NormalizedReviewPage {
  const items = extractItems(payload, options.url);

  const reviews: NormalizedReview[] = [];
  let malformed = 0;

  for (const raw of items) {
    const item = asRecord(raw);
    if (!item) {
      malformed += 1;
      continue;
    }

    const publicationSlug = cleanText(item.publicationSlug);
    const quote = reviewText(item.quote);

    if (!publicationSlug || !quote) {
      malformed += 1;
      continue;
    }

    reviews.push({
      identity: { kind: 'critic', publicationSlug },
      platformSlug: options.platformSlug,
      score: parseScore(item.score, 'critic'),
      quote,
      // У критических отзывов автор часто отсутствует; издание — в ключе
      author: cleanText(item.author) ?? cleanText(item.publicationName),
      reviewUrl: parseUrl(item.url),
      reviewDate: parseDate(item.date),
      sourceVersion: null,
      spoiler: null,
    });
  }

  return {
    kind: 'critic',
    platformSlug: options.platformSlug,
    reviews,
    totalAvailable: extractTotal(payload),
    malformed,
  };
}

/** Выбирает парсер по типу отзывов. */
export function parseReviewPage(
  kind: ReviewKind,
  payload: unknown,
  options: { url: string; platformSlug: string },
): NormalizedReviewPage {
  return kind === 'user'
    ? parseUserReviewPage(payload, options)
    : parseCriticReviewPage(payload, options);
}
