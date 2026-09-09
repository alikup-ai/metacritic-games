/**
 * Доменная модель обогащения игры видеообзорами.
 *
 * Слой domain: без HTTP, SDK и знания о конкретных сервисах.
 */

/** Найденное видео. */
export interface VideoCandidate {
  readonly videoId: string;
  readonly title: string;
  readonly channelTitle: string;
  readonly url: string;
  readonly publishedAt: string | null;
  readonly viewCount: number | null;
  /** Длительность в секундах; null, если источник её не сообщил. */
  readonly durationSeconds: number | null;
  /**
   * Есть ли у ролика субтитры по данным источника.
   *
   * null означает, что источник этого не сообщил. Признак решающий:
   * без субтитров разбор речи невозможен, и такой ролик почти бесполезен.
   */
  readonly hasCaptions: boolean | null;
}

/**
 * Происхождение транскрипта.
 *
 * Различаются намеренно: официальные субтитры точнее автоматических,
 * а `metadata_only` означает, что речи мы не получили и выводы строить
 * не на чем.
 */
export type TranscriptSource =
  | 'official'
  | 'auto'
  | 'external_captions'
  | 'external_asr'
  | 'metadata_only'
  | 'none';

export interface Transcript {
  readonly source: TranscriptSource;
  readonly text: string;
  /** Язык, если источник его сообщил. */
  readonly language: string | null;
}

/**
 * Статус обогащения.
 *
 * `quota_exceeded` отделён от `failed`: исчерпание квоты — штатное
 * ограничение, а не поломка, и реакция на них разная (ADR-0005).
 */
export type VideoInsightStatus = 'ok' | 'failed' | 'skipped' | 'quota_exceeded';

/** Пункт разбора со ссылкой на происхождение. */
export interface VideoPoint {
  readonly text: string;
}

/** Структурированный разбор речи автора видео. */
export interface VideoAnalysisContent {
  readonly summary: string;
  readonly liked: readonly VideoPoint[];
  readonly disliked: readonly VideoPoint[];
  readonly themes: readonly string[];
  readonly conclusion: string;
}

/** Сохранённое обогащение игры. */
export interface VideoInsight {
  readonly gameId: string;
  readonly status: VideoInsightStatus;

  readonly videoId: string | null;
  readonly videoUrl: string | null;
  readonly videoTitle: string | null;
  readonly channelTitle: string | null;
  readonly viewCount: number | null;
  readonly publishedAt: string | null;
  readonly durationSeconds: number | null;

  readonly transcriptSource: TranscriptSource;
  /**
   * Отпечаток транскрипта — ключ идемпотентности.
   *
   * Сам транскрипт не хранится: для работы достаточно отпечатка,
   * сведений о видео и результата разбора.
   */
  readonly transcriptHash: string | null;

  readonly summary: string | null;
  readonly liked: readonly VideoPoint[];
  readonly disliked: readonly VideoPoint[];
  readonly themes: readonly string[];
  readonly conclusion: string | null;

  readonly model: string | null;
  readonly promptVersion: string | null;
  readonly lastError: string | null;
  readonly generatedAt: Date;
}

// ============================================================================
// Отбор видео
// ============================================================================

/** Пределы отбора; значения приходят из конфигурации. */
export interface VideoSelectionLimits {
  /** Короче этого ролик вряд ли содержит разбор игры. */
  readonly minDurationSeconds: number;
  /** Длиннее — обычно полное прохождение, транскрипт неподъёмен. */
  readonly maxDurationSeconds: number;
}

/**
 * Слова, указывающие на разбор игры.
 *
 * Совпадение повышает пригодность ролика, но его отсутствие не
 * отбраковывает: заголовки бывают любыми.
 */
const RELEVANT_MARKERS = [
  'lets play',
  "let's play",
  'letsplay',
  'gameplay',
  'review',
  'обзор',
  'прохождение',
  'первый взгляд',
  'walkthrough',
  'impressions',
  'преглед',
];

/** Признаки роликов, которые разбором не являются. */
const IRRELEVANT_MARKERS = [
  'trailer',
  'трейлер',
  'soundtrack',
  'ost',
  'announcement',
  'анонс',
  'teaser',
  'тизер',
  'speedrun',
  'all cutscenes',
  'все катсцены',
];

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
}

/** Доля слов названия игры, встретившихся в заголовке ролика. */
function titleMatch(gameTitle: string, videoTitle: string): number {
  const words = normalize(gameTitle)
    .split(/\s+/)
    .filter((w) => w.length > 2);
  if (words.length === 0) return 0;

  const haystack = normalize(videoTitle);
  const found = words.filter((word) => haystack.includes(word)).length;
  return found / words.length;
}

export interface ScoredVideo {
  readonly candidate: VideoCandidate;
  readonly score: number;
  /** Почему ролик отклонён; null, если пригоден. */
  readonly rejectedReason: string | null;
}

/**
 * Оценивает пригодность ролика.
 *
 * Правила объяснимые и воспроизводимые: один и тот же набор кандидатов
 * всегда даёт один и тот же выбор.
 */
export function scoreVideo(
  gameTitle: string,
  candidate: VideoCandidate,
  limits: VideoSelectionLimits,
): ScoredVideo {
  const reject = (reason: string): ScoredVideo => ({
    candidate,
    score: 0,
    rejectedReason: reason,
  });

  const haystack = normalize(candidate.title);

  // Ролик должен относиться к нужной игре: половина значимых слов
  // названия — умеренное требование, устойчивое к подзаголовкам.
  const relevance = titleMatch(gameTitle, candidate.title);
  if (relevance < 0.5) return reject('title_mismatch');

  if (IRRELEVANT_MARKERS.some((marker) => haystack.includes(marker))) {
    return reject('not_a_playthrough');
  }

  if (candidate.durationSeconds !== null) {
    // Shorts и клипы: речи для разбора там нет
    if (candidate.durationSeconds < limits.minDurationSeconds) {
      return reject('too_short');
    }
    if (candidate.durationSeconds > limits.maxDurationSeconds) {
      return reject('too_long');
    }
  }

  // Популярность — основной признак: логарифм сглаживает разрыв между
  // роликами с тысячей и миллионом просмотров.
  const views = candidate.viewCount ?? 0;
  const popularity = views > 0 ? Math.log10(views + 1) / 8 : 0;

  const hasMarker = RELEVANT_MARKERS.some((marker) => haystack.includes(marker));

  // Наличие субтитров решающе: без них речь не расшифровать, и разбор
  // не состоится. Поэтому вклад больше, чем у остальных признаков —
  // ролик с субтитрами полезнее более популярного, но безмолвного.
  const captionBonus = candidate.hasCaptions === true ? 0.5 : 0;

  const score =
    relevance * 0.3 +
    Math.min(popularity, 1) * 0.3 +
    (hasMarker ? 0.15 : 0) +
    captionBonus;

  return { candidate, score: Math.round(score * 1000) / 1000, rejectedReason: null };
}

/**
 * Выбирает самый подходящий ролик.
 *
 * Порядок строго определён: по убыванию оценки, при равенстве — по
 * идентификатору видео. Без этого выбор мог бы меняться между запусками.
 */
export function selectBestVideo(
  gameTitle: string,
  candidates: readonly VideoCandidate[],
  limits: VideoSelectionLimits,
): ScoredVideo | null {
  const eligible = candidates
    .map((candidate) => scoreVideo(gameTitle, candidate, limits))
    .filter((scored) => scored.rejectedReason === null);

  if (eligible.length === 0) return null;

  eligible.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.candidate.videoId.localeCompare(b.candidate.videoId);
  });

  return eligible[0] ?? null;
}

// ============================================================================
// Выбор языка расшифровки
// ============================================================================

/**
 * Порядок предпочтения языков по умолчанию.
 *
 * Русский первым: интерфейс русскоязычный, и разбор всё равно выдаётся
 * по-русски. Английский вторым — он покрывает большинство обзоров.
 */
export const DEFAULT_LANGUAGE_PREFERENCE: readonly string[] = ['en', 'ru'];

/**
 * Выбирает язык расшифровки из фактически доступных.
 *
 * Прежняя реализация перебирала только 'en' и 'ru' вслепую и не находила
 * субтитры на других языках, даже когда они есть: у проверенного ролика
 * доступны только немецкие дорожки.
 *
 * Порядок: предпочитаемые языки по очереди, затем язык из конфигурации,
 * затем первый доступный — лучше разобрать немецкий обзор, чем не
 * разобрать никакой.
 */
export function pickTranscriptLanguage(params: {
  available: readonly string[];
  preferred?: readonly string[];
  fallbackLanguage?: string | null;
}): string | null {
  const available = params.available.filter((lang) => lang.length > 0);
  if (available.length === 0) return null;

  // Сравнение по базовому коду: 'en-US' и 'en' считаются одним языком
  const base = (lang: string): string => lang.split('-')[0]!.toLowerCase();
  const byBase = new Map<string, string>();
  for (const lang of available) {
    if (!byBase.has(base(lang))) byBase.set(base(lang), lang);
  }

  const preference = [
    ...(params.preferred ?? DEFAULT_LANGUAGE_PREFERENCE),
    ...(params.fallbackLanguage ? [params.fallbackLanguage] : []),
  ];

  for (const candidate of preference) {
    const found = byBase.get(base(candidate));
    if (found) return found;
  }

  // Ни одного предпочитаемого — берём первый доступный
  return available[0] ?? null;
}
