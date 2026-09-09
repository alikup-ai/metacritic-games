import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbPool } from '../../src/shared/db/pool.js';
import {
  PostgresClaimRepository,
  PostgresProcessingDayRepository,
} from '../../src/modules/ingestion/infrastructure/postgres-claim-repository.js';
import { PostgresRunRepository } from '../../src/modules/monitoring/infrastructure/postgres-run-repository.js';
import { FindNextClaimableGamesUseCase } from '../../src/modules/ingestion/application/find-next-claimable-games.js';
import type {
  FetchGameParams,
  FetchListingParams,
  GameCatalogSource,
  NormalizedGame,
  NormalizedListingItem,
  NormalizedListingPage,
} from '../../src/modules/ingestion/domain/catalog-source.js';
import { createTestPool, setupSchema, truncateAll } from './helpers.js';

/**
 * Regression-тесты Phase 1C Hardening Pass.
 *
 * Покрывают три класса рисков:
 *   1) гонка heartbeat и reaper;
 *   2) корректность захвата ровно нужного количества заявок;
 *   3) семантика причин остановки поиска.
 */

const DAY = '2026-09-07';
const SOURCE = 'metacritic' as const;

let pool: DbPool;
let claims: PostgresClaimRepository;
let processingDays: PostgresProcessingDayRepository;
let runs: PostgresRunRepository;

class ListingStub implements GameCatalogSource {
  readonly source = SOURCE;
  readonly calls: { section: string; page: number }[] = [];

  constructor(private readonly pages: Map<string, string[]>) {}

  async fetchListing(params: FetchListingParams): Promise<NormalizedListingPage> {
    const page = params.page ?? 1;
    this.calls.push({ section: params.section, page });

    const key = params.section === 'new_releases' ? 'new_releases' : `browse:${page}`;
    const slugs = this.pages.get(key) ?? [];

    return {
      section: params.section,
      page,
      items: slugs.map((slug, index): NormalizedListingItem => ({
        source: SOURCE,
        sourceSlug: slug,
        title: slug,
        canonicalUrl: `https://www.metacritic.com/game/${slug}/`,
        coverImageUrl: null,
        position: index,
        releaseDate: null,
        platform: null,
      })),
      skipped: 0,
    };
  }

  async fetchGame(_params: FetchGameParams): Promise<NormalizedGame> {
    throw new Error('не используется');
  }
}

function makeFinder(source: GameCatalogSource, maxEmptyPages = 3, maxPages = 25) {
  return new FindNextClaimableGamesUseCase({
    catalogSource: source,
    claims,
    processingDays,
    maxPagesPerRun: maxPages,
    maxEmptyPages,
    leaseMinutes: 10,
  });
}

async function countClaims(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM daily_claims WHERE processing_day = $1',
    [DAY],
  );
  return Number(rows[0]?.count ?? 0);
}

beforeAll(async () => {
  pool = createTestPool();
  await setupSchema(pool);
  claims = new PostgresClaimRepository(pool);
  processingDays = new PostgresProcessingDayRepository(pool);
  runs = new PostgresRunRepository(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  await processingDays.ensureDay(DAY);
});

// ============================================================================
// 1. Гонка heartbeat и reaper
// ============================================================================

describe('Гонка heartbeat / reaper', () => {
  it('старый воркер НЕ продлевает аренду после отбора заявки reaper', async () => {
    const run = await runs.start('cron', { processingDay: DAY });

    await claims.claimBatch({
      day: DAY,
      runId: run.id,
      candidates: [{ source: SOURCE, sourceSlug: 'raced' }],
      leaseMinutes: 10,
      limit: 1,
    });

    // Аренда истекла, reaper вернул заявку в пул
    await pool.query(
      `UPDATE daily_claims SET lease_until = now() - interval '1 minute'
       WHERE source_slug = 'raced'`,
    );
    const reaped = await claims.reapExpiredLeases({ now: new Date(), maxAttempts: 3 });
    expect(reaped.revived).toBe(1);

    // «Проснувшийся» старый воркер пытается продлить аренду
    const extended = await claims.extendLease({
      day: DAY,
      source: SOURCE,
      sourceSlug: 'raced',
      leaseMinutes: 30,
      runId: run.id,
    });

    // Продление отклонено: заявка больше не в состоянии активной работы
    expect(extended).toBe(false);

    const claim = await claims.find(DAY, SOURCE, 'raced');
    expect(claim!.status).toBe('pending');
    expect(claim!.leaseUntil).toBeNull();
  });

  it('старый воркер НЕ продлевает аренду, перехваченную другим запуском', async () => {
    const runA = await runs.start('cron', { processingDay: DAY });

    await claims.claimBatch({
      day: DAY,
      runId: runA.id,
      candidates: [{ source: SOURCE, sourceSlug: 'stolen' }],
      leaseMinutes: 10,
      limit: 1,
    });

    await pool.query(
      `UPDATE daily_claims SET lease_until = now() - interval '1 minute'
       WHERE source_slug = 'stolen'`,
    );
    await claims.reapExpiredLeases({ now: new Date(), maxAttempts: 3 });
    await runs.finish({ runId: runA.id, status: 'completed' });

    // Следующий запуск перезахватил заявку
    const runB = await runs.start('cron', { processingDay: DAY });
    const reclaimed = await claims.claimBatch({
      day: DAY,
      runId: runB.id,
      candidates: [{ source: SOURCE, sourceSlug: 'stolen' }],
      leaseMinutes: 10,
      limit: 1,
    });
    expect(reclaimed).toHaveLength(1);

    // Старый воркер пытается продлить ЧУЖУЮ теперь заявку
    const extended = await claims.extendLease({
      day: DAY,
      source: SOURCE,
      sourceSlug: 'stolen',
      leaseMinutes: 30,
      runId: runA.id,
    });

    expect(extended).toBe(false);

    // Владелец не изменился: заявка осталась за новым запуском
    const claim = await claims.find(DAY, SOURCE, 'stolen');
    expect(claim!.runId).toBe(runB.id);
    expect(claim!.status).toBe('claimed');
  });

  it('живой воркер продлевает СВОЮ аренду успешно', async () => {
    const run = await runs.start('cron', { processingDay: DAY });

    const [claim] = await claims.claimBatch({
      day: DAY,
      runId: run.id,
      candidates: [{ source: SOURCE, sourceSlug: 'alive' }],
      leaseMinutes: 1,
      limit: 1,
    });
    const before = claim!.leaseUntil!;

    const extended = await claims.extendLease({
      day: DAY,
      source: SOURCE,
      sourceSlug: 'alive',
      leaseMinutes: 30,
      runId: run.id,
    });

    expect(extended).toBe(true);
    const after = await claims.find(DAY, SOURCE, 'alive');
    expect(after!.leaseUntil!.getTime()).toBeGreaterThan(before.getTime());
  });

  it('продление завершённой заявки отклоняется', async () => {
    const run = await runs.start('cron', { processingDay: DAY });

    await claims.claimBatch({
      day: DAY,
      runId: run.id,
      candidates: [{ source: SOURCE, sourceSlug: 'finished' }],
      leaseMinutes: 10,
      limit: 1,
    });
    await claims.markDone({
      day: DAY,
      source: SOURCE,
      sourceSlug: 'finished',
      gameId: null,
      stages: {},
    });

    const extended = await claims.extendLease({
      day: DAY,
      source: SOURCE,
      sourceSlug: 'finished',
      leaseMinutes: 30,
      runId: run.id,
    });

    // Завершённая заявка не воскресает продлением аренды
    expect(extended).toBe(false);
    const claim = await claims.find(DAY, SOURCE, 'finished');
    expect(claim!.status).toBe('done');
  });

  it('продление аренды, истёкшей но ещё не отобранной, отклоняется', async () => {
    const run = await runs.start('cron', { processingDay: DAY });

    await claims.claimBatch({
      day: DAY,
      runId: run.id,
      candidates: [{ source: SOURCE, sourceSlug: 'expired' }],
      leaseMinutes: 10,
      limit: 1,
    });

    // Аренда истекла, но reaper ещё не отработал
    await pool.query(
      `UPDATE daily_claims SET lease_until = now() - interval '1 second'
       WHERE source_slug = 'expired'`,
    );

    const extended = await claims.extendLease({
      day: DAY,
      source: SOURCE,
      sourceSlug: 'expired',
      leaseMinutes: 30,
      runId: run.id,
    });

    // Ключевой момент: воскрешать истёкшую аренду нельзя — reaper мог бы
    // отобрать её в любой момент, и обработка пошла бы в два потока
    expect(extended).toBe(false);
  });
});

// ============================================================================
// 2. Захват ровно нужного количества
// ============================================================================

describe('Захват без избыточных заявок', () => {
  it('создаётся РОВНО limit заявок при избытке кандидатов', async () => {
    const run = await runs.start('cron', { processingDay: DAY });

    const claimed = await claims.claimBatch({
      day: DAY,
      runId: run.id,
      candidates: Array.from({ length: 50 }, (_, i) => ({
        source: SOURCE,
        sourceSlug: `bulk-${i}`,
      })),
      leaseMinutes: 10,
      limit: 20,
    });

    expect(claimed).toHaveLength(20);
    // Лишние заявки не создавались даже временно
    expect(await countClaims()).toBe(20);
  });

  it('уже заявленные кандидаты не расходуют лимит', async () => {
    const run = await runs.start('cron', { processingDay: DAY });

    // Первые 5 игр уже обработаны сегодня
    await claims.claimBatch({
      day: DAY,
      runId: run.id,
      candidates: Array.from({ length: 5 }, (_, i) => ({
        source: SOURCE,
        sourceSlug: `pre-${i}`,
      })),
      leaseMinutes: 10,
      limit: 5,
    });

    // Кандидаты: 5 уже заявленных + 15 новых, лимит 10
    const candidates = [
      ...Array.from({ length: 5 }, (_, i) => ({ source: SOURCE, sourceSlug: `pre-${i}` })),
      ...Array.from({ length: 15 }, (_, i) => ({ source: SOURCE, sourceSlug: `new-${i}` })),
    ];

    const claimed = await claims.claimBatch({
      day: DAY,
      runId: run.id,
      candidates,
      leaseMinutes: 10,
      limit: 10,
    });

    // Ровно 10 новых: заявленные не «съели» лимит
    expect(claimed).toHaveLength(10);
    expect(claimed.every((c) => c.sourceSlug.startsWith('new-'))).toBe(true);
    expect(await countClaims()).toBe(15);
  });

  it('при конкуренции не возникает дублей и потерянных заявок', async () => {
    const run = await runs.start('cron', { processingDay: DAY });
    const candidates = Array.from({ length: 20 }, (_, i) => ({
      source: SOURCE,
      sourceSlug: `race-${i}`,
    }));

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        claims.claimBatch({ day: DAY, runId: run.id, candidates, leaseMinutes: 10, limit: 8 }),
      ),
    );

    const allSlugs = results.flat().map((c) => c.sourceSlug);
    // Ни одна заявка не выдана дважды
    expect(new Set(allSlugs).size).toBe(allSlugs.length);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM (
         SELECT source_slug FROM daily_claims WHERE processing_day = $1
         GROUP BY source_slug HAVING count(*) > 1
       ) dup`,
      [DAY],
    );
    expect(Number(rows[0]!.count)).toBe(0);

    // Все выданные заявки существуют в БД — ничего не потеряно
    expect(await countClaims()).toBe(allSlugs.length);
  });

  it('сбой после захвата не теряет заявки: их подберёт reaper', async () => {
    const run = await runs.start('cron', { processingDay: DAY });

    const claimed = await claims.claimBatch({
      day: DAY,
      runId: run.id,
      candidates: Array.from({ length: 5 }, (_, i) => ({
        source: SOURCE,
        sourceSlug: `orphan-${i}`,
      })),
      leaseMinutes: 10,
      limit: 5,
    });
    expect(claimed).toHaveLength(5);

    // Процесс упал сразу после захвата: заявки остались с арендой
    await pool.query(
      `UPDATE daily_claims SET lease_until = now() - interval '1 minute'
       WHERE processing_day = $1`,
      [DAY],
    );

    const reaped = await claims.reapExpiredLeases({ now: new Date(), maxAttempts: 3 });

    // Все заявки возвращены в пул — ни одна не потеряна навсегда
    expect(reaped.revived).toBe(5);
    expect(await countClaims()).toBe(5);

    const counts = await claims.countByStatus(DAY);
    expect(counts.pending).toBe(5);
  });
});

// ============================================================================
// 3. Семантика остановки поиска
// ============================================================================

describe('Причины остановки поиска', () => {
  it('НЕ останавливается преждевременно при дрейфе пагинации', async () => {
    // Реальный дрейф: страницы РАЗНЫЕ (отпечатки не повторяются), но все
    // игры на них уже заявлены сегодня. Прежняя логика считала такие
    // страницы «пустыми» и прекращала поиск после третьей.
    const pages = new Map<string, string[]>([
      ['new_releases', ['seed-1', 'seed-2']],
    ]);
    // Каждая страница уникальна по составу, но состоит из уже заявленных игр
    for (let i = 1; i <= 6; i += 1) {
      pages.set(`browse:${i}`, ['seed-1', 'seed-2', `filler-${i}`]);
    }
    pages.set('browse:7', ['fresh-1', 'fresh-2', 'fresh-3']);

    const source = new ListingStub(pages);
    const run = await runs.start('cron', { processingDay: DAY });

    const result = await makeFinder(source, 3, 25).execute({
      processingDay: DAY,
      runId: run.id,
      targetCount: 5,
    });

    // Дошли до страницы с новыми играми, несмотря на череду страниц,
    // состоящих преимущественно из уже заявленных
    expect(result.claims.length).toBe(5);
    expect(result.stopReason).toBe('target_reached');
    // Просмотрено больше трёх страниц — прежний порог не сработал
    expect(result.pagesScanned).toBeGreaterThan(3);
  });

  it('действительно пустые страницы останавливают поиск быстро', async () => {
    const pages = new Map<string, string[]>([
      ['new_releases', ['only-1']],
      ['browse:1', []],
      ['browse:2', []],
      ['browse:3', []],
      ['browse:4', ['never-reached']],
    ]);

    const source = new ListingStub(pages);
    const run = await runs.start('cron', { processingDay: DAY });

    const result = await makeFinder(source, 3, 25).execute({
      processingDay: DAY,
      runId: run.id,
      targetCount: 20,
    });

    // Источник физически закончился — сильный сигнал, останавливаемся
    expect(result.stopReason).toBe('source_exhausted');
    expect(result.claims).toHaveLength(1);
  });

  it('повторяющаяся страница останавливает поиск', async () => {
    const same = ['dup-1', 'dup-2'];
    const pages = new Map<string, string[]>([['new_releases', ['nr-1']]]);
    for (let i = 1; i <= 30; i += 1) pages.set(`browse:${i}`, same);

    const source = new ListingStub(pages);
    const run = await runs.start('cron', { processingDay: DAY });

    const result = await makeFinder(source, 3, 25).execute({
      processingDay: DAY,
      runId: run.id,
      targetCount: 20,
    });

    // Отпечаток набора повторился — источник зациклился
    expect(result.stopReason).toBe('repeated_page');
    expect(source.calls.length).toBeLessThan(10);
  });

  it('насыщение отличается от исчерпания источника', async () => {
    // Все страницы непустые, но игры одни и те же (уже заявленные).
    // Отпечаток повторится раньше, чем сработает порог насыщения.
    const pages = new Map<string, string[]>([['new_releases', ['s-1', 's-2', 's-3']]]);
    for (let i = 1; i <= 30; i += 1) {
      pages.set(`browse:${i}`, ['s-1', 's-2', 's-3']);
    }

    const source = new ListingStub(pages);
    const run = await runs.start('cron', { processingDay: DAY });

    const result = await makeFinder(source, 3, 25).execute({
      processingDay: DAY,
      runId: run.id,
      targetCount: 20,
    });

    // Причина — повтор источника, а не мнимое исчерпание
    expect(result.stopReason).toBe('repeated_page');
    expect(result.claims).toHaveLength(3);
  });

  it('предел страниц срабатывает при бесконечном разнообразии', async () => {
    // Каждая страница уникальна, но все игры уже заявлены
    const pages = new Map<string, string[]>([['new_releases', ['base-1']]]);
    for (let i = 1; i <= 40; i += 1) pages.set(`browse:${i}`, [`base-1`, `x-${i}`]);

    const source = new ListingStub(pages);
    const run = await runs.start('cron', { processingDay: DAY });

    const result = await makeFinder(source, 3, 6).execute({
      processingDay: DAY,
      runId: run.id,
      targetCount: 100,
    });

    // Защита от бесконечного листания сохранена
    expect(result.stopReason).toBe('page_limit');
    expect(result.pagesScanned).toBeLessThanOrEqual(6);
  });
});
