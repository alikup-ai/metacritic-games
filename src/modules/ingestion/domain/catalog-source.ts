/**
 * Порт источника каталога игр.
 *
 * Объявлен в domain и не знает ни про HTTP, ни про HTML, ни про Metacritic:
 * здесь нет ни одного импорта из infrastructure (ADR-0001). Конкретный
 * источник подключается адаптером в composition root.
 */

import type { DeveloperStatus, GameSource, ScoreScope } from '../../catalog/domain/game.js';

/** Раздел листинга. Соответствует двум источникам выборки из ТЗ. */
export type ListingSection = 'new_releases' | 'browse_all_new';

/**
 * Элемент листинга — результат разбора страницы со списком игр.
 *
 * Содержит только то, что реально присутствует на странице списка.
 * Полные данные извлекаются отдельно, из карточки игры.
 */
export interface NormalizedListingItem {
  readonly source: GameSource;
  readonly sourceSlug: string;
  readonly title: string;
  readonly canonicalUrl: string;
  readonly coverImageUrl: string | null;
  /** Позиция карточки в списке, начиная с 0 — сохраняет порядок источника. */
  readonly position: number;
  /** ISO-дата (YYYY-MM-DD); может быть будущей. */
  readonly releaseDate: string | null;
  /** Платформа, если указана на карточке списка. */
  readonly platform: string | null;
}

/** Результат разбора страницы листинга. */
export interface NormalizedListingPage {
  readonly section: ListingSection;
  readonly page: number;
  readonly items: readonly NormalizedListingItem[];
  /**
   * Карточки, которые не удалось разобрать. Ненулевое значение — сигнал о
   * возможной смене разметки; успешный результат с пустым списком при этом
   * не выдаётся (см. ParseError).
   */
  readonly skipped: number;
}

/** Оценки по одной платформе. */
export interface NormalizedPlatformScore {
  /** Нормализованный код: playstation-5, xbox-series-x, pc. */
  readonly platform: string;
  /** Отображаемое имя с источника: "PlayStation 5". */
  readonly platformName: string;
  /** null означает 'tbd' — платформа известна, оценки ещё нет. */
  readonly metascore: number | null;
  readonly metascoreScope: ScoreScope;
  readonly userscore: number | null;
  readonly userscoreScope: ScoreScope;
  readonly criticCount: number | null;
}

/**
 * Нормализованная игра.
 *
 * Структура не повторяет HTML источника: имена полей доменные, значения
 * приведены к общим типам, специфика Metacritic (data-testid, JSON-LD, классы)
 * остаётся в адаптере.
 */
export interface NormalizedGame {
  readonly source: GameSource;
  readonly sourceSlug: string;
  readonly title: string;
  readonly canonicalUrl: string;
  readonly coverImageUrl: string | null;

  /**
   * null при developerStatus === 'unknown'.
   * Издатель НИКОГДА не используется как запасное значение (ADR-0003).
   */
  readonly developer: string | null;
  readonly developerStatus: DeveloperStatus;
  readonly publishers: readonly string[];

  readonly description: string | null;
  readonly videoUrl: string | null;
  readonly genres: readonly string[];
  readonly releaseDate: string | null;

  /** Агрегированная оценка по игре в целом; null, если не опубликована. */
  readonly metascoreOverall: number | null;
  readonly userscoreOverall: number | null;

  /**
   * Почему Userscore отсутствует. Позволяет отличить сбой запроса от
   * штатного отсутствия значения — реакция на них разная.
   * 'fetched' означает, что значение получено.
   */
  readonly userscoreStatus: UserscoreStatus;

  readonly platforms: readonly NormalizedPlatformScore[];

  /** Версия парсера — позволяет найти записи, извлечённые старой логикой. */
  readonly parserVersion: string;
}

/** Исход получения общего Userscore. */
export type UserscoreStatus = 'fetched' | 'absent' | 'failed' | 'disabled';

export interface FetchListingParams {
  readonly section: ListingSection;
  /** Нумерация с 1; для new_releases игнорируется. */
  readonly page?: number;
  readonly signal?: AbortSignal;
}

export interface FetchGameParams {
  readonly sourceSlug: string;
  readonly signal?: AbortSignal;
}

/**
 * Источник каталога игр.
 *
 * Контракт: методы либо возвращают нормализованный результат, либо бросают
 * типизированную ошибку. Молчаливый «успех с пустыми полями» при непонятной
 * структуре страницы недопустим — он бы выглядел как отсутствие данных.
 */
export interface GameCatalogSource {
  readonly source: GameSource;

  fetchListing(params: FetchListingParams): Promise<NormalizedListingPage>;

  fetchGame(params: FetchGameParams): Promise<NormalizedGame>;
}
