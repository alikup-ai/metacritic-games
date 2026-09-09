import type { GameCatalogSource, ListingSection } from '../domain/catalog-source.js';
import type { ClaimRepository, ProcessingDayRepository } from '../domain/claim-repository.js';
import type { DailyClaim } from '../domain/claim.js';
import { isIngestionError } from '../domain/ingestion-errors.js';

/**
 * Поиск и захват следующих необработанных сегодня игр.
 *
 * Главное правило (ADR-0002): номер страницы — ПОДСКАЗКА, а источником
 * истины о том, что уже обработано, является реестр daily_claims.
 *
 * Причина: листинг Metacritic дрейфует. Замер на фикстурах, снятых с
 * интервалом ~1.3 с, показал 5 общих игр из 20 между страницами 1 и 2,
 * смещённых по позициям. Предположение «страница 2 = игры 21..40» неверно:
 * оно приводило бы и к повторам, и к молчаливым пропускам.
 *
 * Поэтому алгоритм листает страницы, отбрасывая уже заявленные слаги, пока
 * не наберёт нужное число ДЕЙСТВИТЕЛЬНО новых заявок.
 */

export interface FindNextClaimableGamesDeps {
  readonly catalogSource: GameCatalogSource;
  readonly claims: ClaimRepository;
  readonly processingDays: ProcessingDayRepository;
  readonly maxPagesPerRun: number;
  readonly maxEmptyPages: number;
  readonly leaseMinutes: number;
}

export interface FindNextClaimableGamesParams {
  readonly processingDay: string;
  readonly runId: string;
  readonly targetCount: number;
  readonly signal?: AbortSignal;
}

/** Почему поиск остановился — важно для отчётности и диагностики. */
/**
 * Почему поиск остановился.
 *
 * Причины намеренно различаются по силе сигнала:
 * - repeated_page / source_exhausted — СИЛЬНЫЙ сигнал: источник повторяется
 *   или физически закончился, продолжать бессмысленно;
 * - saturated — все просмотренные игры уже заявлены сегодня; это штатное
 *   состояние ближе к концу суточной выборки, а не поломка;
 * - page_limit — защитный предел, а не свойство источника.
 */
export type StopReason =
  | 'target_reached'
  | 'source_exhausted'
  | 'saturated'
  | 'page_limit'
  | 'repeated_page'
  | 'source_error';

export interface FindNextClaimableGamesResult {
  readonly claims: readonly DailyClaim[];
  readonly pagesScanned: number;
  readonly lastPage: number;
  readonly strategy: 'new_releases' | 'browse' | 'mixed';
  readonly stopReason: StopReason;
  /** Кандидаты, отброшенные как уже заявленные сегодня. */
  readonly skippedAlreadyClaimed: number;
}

export class FindNextClaimableGamesUseCase {
  constructor(private readonly deps: FindNextClaimableGamesDeps) {}

  async execute(
    params: FindNextClaimableGamesParams,
  ): Promise<FindNextClaimableGamesResult> {
    const day = await this.deps.processingDays.ensureDay(params.processingDay);

    const collected: DailyClaim[] = [];
    let pagesScanned = 0;
    // Страницы БЕЗ ЕДИНОЙ карточки — источник действительно закончился.
    let trulyEmptyPages = 0;
    // Страницы с карточками, но все игры уже заявлены сегодня. Это НЕ
    // признак поломки: при дрейфе пагинации такие страницы нормальны,
    // поэтому порог для них отдельный и заметно выше.
    let saturatedPages = 0;
    let skippedAlreadyClaimed = 0;
    let stopReason: StopReason = 'target_reached';
    let usedNewReleases = false;
    let usedBrowse = false;
    // Раздел новинок пройден полностью — фаза больше не вернётся к нему
    // в текущие сутки.
    let newReleasesCompleted = false;

    // Отпечатки уже прочитанных страниц: защита от источника, который
    // отдаёт один и тот же набор игр (иначе получился бы бесконечный цикл).
    const seenPageSignatures = new Set<string>();
    let page = Math.max(1, day.browsePage);

    // Новые сутки начинаются с раздела New Releases — требование ТЗ.
    // Фаза хранится в processing_days и переживает перезапуск.
    let section: ListingSection =
      day.phase === 'new_releases' ? 'new_releases' : 'browse_all_new';

    while (collected.length < params.targetCount) {
      if (params.signal?.aborted) {
        stopReason = 'source_error';
        break;
      }

      if (pagesScanned >= this.deps.maxPagesPerRun) {
        stopReason = 'page_limit';
        break;
      }

      let listing;
      try {
        listing = await this.deps.catalogSource.fetchListing({
          section,
          ...(section === 'browse_all_new' ? { page } : {}),
          ...(params.signal ? { signal: params.signal } : {}),
        });
      } catch (error) {
        // Ошибка источника прекращает поиск, но уже собранные заявки
        // остаются валидными: они зафиксированы в реестре.
        stopReason = 'source_error';
        if (isIngestionError(error) && error.category === 'blocked') throw error;
        break;
      }

      pagesScanned += 1;
      if (section === 'new_releases') usedNewReleases = true;
      else usedBrowse = true;

      // Отпечаток набора слагов, а не номера страницы: источник может
      // отдавать одно и то же содержимое под разными номерами.
      const signature = listing.items
        .map((item) => item.sourceSlug)
        .sort()
        .join(',');

      if (signature.length > 0 && seenPageSignatures.has(signature)) {
        stopReason = 'repeated_page';
        break;
      }
      seenPageSignatures.add(signature);

      // Страница без карточек: источник исчерпан. Это сильный сигнал.
      if (listing.items.length === 0) {
        trulyEmptyPages += 1;
        if (trulyEmptyPages >= this.deps.maxEmptyPages) {
          stopReason = 'source_exhausted';
          break;
        }
        page = this.advance(section, page);
        section = this.nextSection(section);
        continue;
      }

      const remaining = params.targetCount - collected.length;
      const claimed = await this.deps.claims.claimBatch({
        day: params.processingDay,
        runId: params.runId,
        candidates: listing.items.map((item) => ({
          source: item.source,
          sourceSlug: item.sourceSlug,
        })),
        leaseMinutes: this.deps.leaseMinutes,
        limit: remaining,
      });

      // Разница между кандидатами и заявками — это игры, уже обработанные
      // сегодня. Именно так дрейф листинга становится безвредным.
      skippedAlreadyClaimed += Math.max(0, listing.items.length - claimed.length);
      collected.push(...claimed);

      if (claimed.length === 0) {
        // Карточки есть, но все игры уже заявлены сегодня. При дрейфе
        // листинга это нормально: страницы частично пересекаются, и
        // несколько подряд «насыщенных» страниц не означают исчерпания.
        //
        // Порог для этого случая — отдельный и заметно выше, иначе поиск
        // прекращался бы на нормальном дрейфе и недобирал бы игры.
        saturatedPages += 1;
        if (saturatedPages >= this.saturatedPageLimit()) {
          stopReason = 'saturated';
          break;
        }
      } else {
        // Любая новая заявка сбрасывает оба счётчика: источник жив
        // и продолжает отдавать необработанные игры.
        saturatedPages = 0;
        trulyEmptyPages = 0;
      }

      // Раздел New Releases конечен и просматривается целиком за один
      // проход. Фаза переключается СРАЗУ после его обработки — даже если
      // цель уже достигнута. Иначе следующий запуск снова начал бы с
      // новинок, где все игры уже заявлены, и потратил бы запрос впустую.
      if (section === 'new_releases') {
        await this.deps.processingDays.update(params.processingDay, {
          phase: 'browse',
          newReleasesDone: true,
        });
        newReleasesCompleted = true;
        section = 'browse_all_new';

        if (collected.length >= params.targetCount) {
          stopReason = 'target_reached';
          break;
        }
        continue;
      }

      if (collected.length >= params.targetCount) {
        stopReason = 'target_reached';
        break;
      }

      page += 1;
    }

    // Курсор сохраняется сразу: он подсказка, но без него следующий запуск
    // начинал бы листать с начала и тратил бы запросы впустую.
    await this.deps.processingDays.update(params.processingDay, {
      browsePage: Math.max(1, page),
      ...(newReleasesCompleted || section === 'browse_all_new'
        ? { phase: 'browse' as const, newReleasesDone: true }
        : {}),
    });

    return {
      claims: collected,
      pagesScanned,
      lastPage: page,
      strategy:
        usedNewReleases && usedBrowse
          ? 'mixed'
          : usedNewReleases
            ? 'new_releases'
            : 'browse',
      stopReason,
      skippedAlreadyClaimed,
    };
  }

  /**
   * Предел подряд идущих «насыщенных» страниц (все игры уже заявлены).
   *
   * Заметно выше порога действительно пустых страниц: насыщенность —
   * штатное следствие дрейфа пагинации, а не признак поломки источника.
   * Ограничен сверху лимитом страниц, чтобы защита от зацикливания
   * оставалась в силе.
   */
  private saturatedPageLimit(): number {
    return Math.max(this.deps.maxEmptyPages * 3, this.deps.maxPagesPerRun);
  }

  private advance(section: ListingSection, page: number): number {
    return section === 'browse_all_new' ? page + 1 : page;
  }

  private nextSection(section: ListingSection): ListingSection {
    return section === 'new_releases' ? 'browse_all_new' : section;
  }
}
