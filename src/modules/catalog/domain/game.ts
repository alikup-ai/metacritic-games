/**
 * Доменная модель каталога игр.
 *
 * Слой domain не зависит от инфраструктуры: здесь нет импортов pg, HTTP-клиентов
 * и SDK внешних сервисов (ADR-0001).
 */

/** Источник данных. Заложен заранее, чтобы добавление второго источника
 *  не потребовало миграции первичного ключа (ADR-0003). */
export type GameSource = 'metacritic';

/**
 * Статус определения разработчика.
 * Подмена developer на publisher запрещена: если разработчик не найден,
 * поле остаётся пустым со статусом 'unknown' (ADR-0003).
 */
export type DeveloperStatus = 'resolved' | 'unknown';

/**
 * Достоверность привязки оценки к платформе (ADR-0008).
 *
 * - platform:         оценка относится именно к этой платформе (доказано для Metascore)
 * - overall:          источник ПУБЛИКУЕТ только общую оценку по игре. Штатное состояние —
 *                     Metacritic не даёт Userscore по платформам
 * - overall_fallback: источник, вероятно, даёт оценку по платформам, но связать её
 *                     достоверно НЕ УДАЛОСЬ. Деградация, сигнал о смене разметки
 * - derived:          рассчитана нами; на MVP не используется
 *
 * Разделение overall и overall_fallback принципиально: первое не требует внимания,
 * второе — требует. Общий термин делал бы поломку парсера невидимой.
 */
export type ScoreScope = 'platform' | 'overall' | 'overall_fallback' | 'derived';

/** Внешний идентификатор игры: canonical slug + источник (ADR-0003). */
export interface GameIdentity {
  readonly source: GameSource;
  readonly sourceSlug: string;
}

/** Оценки по конкретной платформе. */
export interface GamePlatform {
  readonly platformSlug: string;
  readonly platformName: string;
  /** null означает 'tbd' — платформа известна, оценки ещё нет. */
  readonly metascore: number | null;
  readonly metascoreScope: ScoreScope;
  readonly userscore: number | null;
  readonly userscoreScope: ScoreScope;
  readonly criticCount: number | null;
  readonly userCount: number | null;
}

/** Игра в каталоге. */
export interface Game {
  readonly id: string;
  readonly source: GameSource;
  readonly sourceSlug: string;
  readonly sourceUrl: string | null;
  readonly parserVersion: string;

  readonly title: string;
  readonly description: string | null;
  readonly coverUrl: string | null;
  readonly trailerUrl: string | null;

  /** null допустим — подтверждён реальный случай отсутствия данных. */
  readonly developer: string | null;
  readonly developerStatus: DeveloperStatus;
  readonly publishers: readonly string[];

  readonly genres: readonly string[];
  readonly releaseDate: string | null;

  readonly metascoreOverall: number | null;
  readonly userscoreOverall: number | null;

  readonly contentHash: string | null;
  readonly firstSeenAt: Date;
  readonly lastUpdatedAt: Date;
}

/** Данные для создания или обновления игры (upsert по natural key). */
export interface GameUpsertInput {
  readonly source: GameSource;
  readonly sourceSlug: string;
  readonly sourceUrl?: string | null;
  readonly parserVersion: string;

  readonly title: string;
  readonly description?: string | null;
  readonly coverUrl?: string | null;
  readonly trailerUrl?: string | null;

  readonly developer?: string | null;
  readonly developerStatus: DeveloperStatus;
  readonly publishers?: readonly string[];

  readonly genres?: readonly string[];
  readonly releaseDate?: string | null;

  readonly metascoreOverall?: number | null;
  readonly userscoreOverall?: number | null;
  readonly contentHash?: string | null;
}

/**
 * Проверка инварианта: разработчик не может считаться определённым,
 * если значение отсутствует. То же ограничение продублировано в БД —
 * здесь оно даёт понятную ошибку до обращения к базе.
 */
export function assertDeveloperConsistency(input: {
  developer?: string | null;
  developerStatus: DeveloperStatus;
}): void {
  if (input.developerStatus === 'resolved' && !input.developer) {
    throw new Error(
      'Некорректные данные: developerStatus="resolved" при отсутствующем developer. ' +
        'Подмена разработчика издателем запрещена (ADR-0003).',
    );
  }
}
