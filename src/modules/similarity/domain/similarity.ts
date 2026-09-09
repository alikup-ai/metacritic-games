/**
 * Подбор похожих игр.
 *
 * Правила объяснимые и воспроизводимые: ни модели, ни векторов, ни
 * внешних сервисов. Один и тот же набор игр всегда даёт один и тот же
 * результат — это требование, а не побочный эффект.
 *
 * Слой domain: только чистые функции, без обращений к базе.
 */

/** Данные игры, участвующие в подборе. */
export interface SimilarityCandidate {
  readonly id: string;
  readonly title: string;
  readonly coverUrl: string | null;
  readonly releaseDate: string | null;
  readonly developer: string | null;
  readonly publishers: readonly string[];
  readonly genres: readonly string[];
  readonly metascore: number | null;
  readonly userscore: number | null;
  /** Слаги активных платформ. */
  readonly platforms: readonly string[];
}

/** Признак, по которому игры признаны похожими. */
export type SimilarityReasonKind =
  | 'genre'
  | 'developer'
  | 'publisher'
  | 'platform'
  | 'score'
  | 'era';

export interface SimilarityReason {
  readonly kind: SimilarityReasonKind;
  /** Готовая формулировка для показа пользователю. */
  readonly label: string;
  /** Вклад признака в итоговую оценку, 0..1 от максимума. */
  readonly weight: number;
}

export interface SimilarGame {
  readonly candidate: SimilarityCandidate;
  /** Итоговая близость, 0..1. */
  readonly score: number;
  readonly reasons: readonly SimilarityReason[];
}

/**
 * Веса признаков.
 *
 * Подобраны по смыслу, а не подгонкой: жанр и разработчик говорят о
 * сходстве игры сильнее, чем совпадение платформы, которое у крупных
 * релизов почти всегда есть и потому мало что различает.
 *
 * Сумма весов равна 1, поэтому итоговая оценка уже нормализована.
 */
const WEIGHTS = {
  genre: 0.35,
  developer: 0.25,
  publisher: 0.15,
  platform: 0.1,
  score: 0.1,
  era: 0.05,
} as const;

/** Ниже этого порога игры считаются несвязанными и не показываются. */
const MIN_SCORE = 0.15;

/**
 * Признаки, которые сами по себе означают сходство.
 *
 * Платформа, оценка и год — вспомогательные: они есть почти у любой пары
 * игр одного периода и без содержательного признака дали бы выдачу
 * случайных игр.
 */
const SUBSTANTIVE_KINDS: readonly SimilarityReasonKind[] = [
  'genre',
  'developer',
  'publisher',
];

export const MAX_SIMILAR = 5;

/** Приведение к сопоставимому виду: регистр и пробелы не должны мешать. */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeAll(values: readonly string[]): Set<string> {
  return new Set(values.map(normalize).filter((v) => v.length > 0));
}

/**
 * Доля общих элементов (Жаккар).
 *
 * Учитывает и размер множеств: две игры с единственным общим жанром из
 * одного похожи сильнее, чем игры с одним общим из пяти.
 */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  for (const value of a) if (b.has(value)) shared += 1;
  if (shared === 0) return 0;

  return shared / (a.size + b.size - shared);
}

/** Общие элементы в исходном написании — для объяснения. */
function sharedValues(a: readonly string[], b: readonly string[]): string[] {
  const other = normalizeAll(b);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of a) {
    const key = normalize(value);
    if (other.has(key) && !seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

/** Год выхода; null, если дата отсутствует или не разбирается. */
function releaseYear(date: string | null): number | null {
  if (!date) return null;
  const match = /^(\d{4})/.exec(date);
  return match ? Number(match[1]) : null;
}

/**
 * Близость оценок.
 *
 * Считается только когда обе оценки известны: отсутствие оценки — это
 * незнание, а не «ноль баллов», и подставлять его нельзя.
 */
function scoreCloseness(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;

  // Шкала 0-100; разница в 20 баллов и больше считается несходством
  const distance = Math.abs(a - b);
  return distance >= 20 ? 0 : 1 - distance / 20;
}

/** Близость по времени выхода: одно поколение игр ощущается схожим. */
function eraCloseness(a: string | null, b: string | null): number | null {
  const yearA = releaseYear(a);
  const yearB = releaseYear(b);
  if (yearA === null || yearB === null) return null;

  const distance = Math.abs(yearA - yearB);
  return distance >= 5 ? 0 : 1 - distance / 5;
}

function joinList(values: readonly string[], limit = 2): string {
  return values.slice(0, limit).join(', ');
}

/**
 * Сравнивает две игры.
 *
 * Возвращает null, если сходство ниже порога: показывать случайные игры
 * хуже, чем не показывать ничего.
 */
export function compareGames(
  target: SimilarityCandidate,
  candidate: SimilarityCandidate,
): SimilarGame | null {
  // Игра не похожа сама на себя
  if (candidate.id === target.id) return null;

  const reasons: SimilarityReason[] = [];
  let score = 0;

  // --- Жанр
  const genreScore = overlap(normalizeAll(target.genres), normalizeAll(candidate.genres));
  if (genreScore > 0) {
    const shared = sharedValues(target.genres, candidate.genres);
    score += genreScore * WEIGHTS.genre;
    reasons.push({
      kind: 'genre',
      label: shared.length === 1 ? `тот же жанр: ${shared[0]}` : `похожие жанры: ${joinList(shared)}`,
      weight: genreScore * WEIGHTS.genre,
    });
  }

  // --- Разработчик
  if (
    target.developer !== null &&
    candidate.developer !== null &&
    normalize(target.developer) === normalize(candidate.developer)
  ) {
    score += WEIGHTS.developer;
    reasons.push({
      kind: 'developer',
      label: `тот же разработчик: ${candidate.developer}`,
      weight: WEIGHTS.developer,
    });
  }

  // --- Издатель
  const publisherScore = overlap(
    normalizeAll(target.publishers),
    normalizeAll(candidate.publishers),
  );
  if (publisherScore > 0) {
    const shared = sharedValues(target.publishers, candidate.publishers);
    score += publisherScore * WEIGHTS.publisher;
    reasons.push({
      kind: 'publisher',
      label: `тот же издатель: ${joinList(shared, 1)}`,
      weight: publisherScore * WEIGHTS.publisher,
    });
  }

  // --- Платформы
  const platformScore = overlap(
    normalizeAll(target.platforms),
    normalizeAll(candidate.platforms),
  );
  if (platformScore > 0) {
    score += platformScore * WEIGHTS.platform;
    reasons.push({
      kind: 'platform',
      label: 'выходит на тех же платформах',
      weight: platformScore * WEIGHTS.platform,
    });
  }

  // --- Близость оценок критиков
  const closeness = scoreCloseness(target.metascore, candidate.metascore);
  if (closeness !== null && closeness > 0) {
    score += closeness * WEIGHTS.score;
    reasons.push({
      kind: 'score',
      label: 'сопоставимые оценки критиков',
      weight: closeness * WEIGHTS.score,
    });
  }

  // --- Близость по времени выхода
  const era = eraCloseness(target.releaseDate, candidate.releaseDate);
  if (era !== null && era > 0) {
    score += era * WEIGHTS.era;
    reasons.push({
      kind: 'era',
      label: 'вышли примерно в одно время',
      weight: era * WEIGHTS.era,
    });
  }

  const hasSubstantiveReason = reasons.some((reason) =>
    SUBSTANTIVE_KINDS.includes(reason.kind),
  );

  if (!hasSubstantiveReason || score < MIN_SCORE) return null;

  // Причины по убыванию вклада. При равном вкладе вперёд идёт
  // содержательный признак: «тот же издатель» объясняет сходство лучше,
  // чем «те же платформы», даже когда весят они одинаково.
  const ordered = [...reasons].sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;

    const aSubstantive = SUBSTANTIVE_KINDS.includes(a.kind) ? 0 : 1;
    const bSubstantive = SUBSTANTIVE_KINDS.includes(b.kind) ? 0 : 1;
    if (aSubstantive !== bSubstantive) return aSubstantive - bSubstantive;

    // Устойчивый порядок при полном равенстве
    return a.kind.localeCompare(b.kind);
  });

  return {
    candidate,
    // Оценка округляется: различия в тысячных не несут смысла и мешают
    // воспроизводимости при сравнении
    score: Math.round(Math.min(score, 1) * 1000) / 1000,
    reasons: ordered,
  };
}

/**
 * Подбирает похожие игры.
 *
 * Порядок строго определён: по убыванию оценки, при равенстве — по
 * идентификатору. Без этого две игры с одинаковой близостью могли бы
 * меняться местами между запросами.
 */
export function findSimilarGames(
  target: SimilarityCandidate,
  candidates: readonly SimilarityCandidate[],
  limit: number = MAX_SIMILAR,
): readonly SimilarGame[] {
  const scored: SimilarGame[] = [];

  for (const candidate of candidates) {
    const result = compareGames(target, candidate);
    if (result !== null) scored.push(result);
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.candidate.id.localeCompare(b.candidate.id);
  });

  return scored.slice(0, Math.max(0, limit));
}
