import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbPool } from '../../src/shared/db/pool.js';
import { PostgresUnitOfWork } from '../../src/shared/db/unit-of-work.js';
import { PostgresRunLock } from '../../src/shared/db/run-lock.js';
import { PostgresGameRepository } from '../../src/modules/catalog/infrastructure/postgres-game-repository.js';
import { PostgresGamePlatformRepository } from '../../src/modules/catalog/infrastructure/postgres-game-platform-repository.js';
import {
  PostgresClaimRepository,
  PostgresProcessingDayRepository,
} from '../../src/modules/ingestion/infrastructure/postgres-claim-repository.js';
import { PostgresRunRepository } from '../../src/modules/monitoring/infrastructure/postgres-run-repository.js';
import { IngestGameUseCase } from '../../src/modules/ingestion/application/ingest-game.js';
import { ProcessGamePipeline } from '../../src/modules/ingestion/application/process-game-pipeline.js';
import { FindNextClaimableGamesUseCase } from '../../src/modules/ingestion/application/find-next-claimable-games.js';
import { RunDailyProcessingUseCase } from '../../src/modules/ingestion/application/run-daily-processing.js';
import { RecordingEventSink } from '../../src/modules/ingestion/domain/ingestion-events.js';
import { FixedProcessingDayProvider } from '../../src/modules/ingestion/domain/processing-day-provider.js';
import { IngestionError } from '../../src/modules/ingestion/domain/ingestion-errors.js';
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
 * Интеграционные тесты суточной обработки на РЕАЛЬНОЙ PostgreSQL.
 *
 * Источник каталога подменяется управляемой реализацией: тесты не зависят
 * от живого Metacritic. Но конкурентность и ограничения целостности
 * проверяются на настоящей БД — на моках гонки не воспроизводятся.
 */

const DAY_1 = new Date('2026-09-07T10:00:00Z');
const DAY_2 = new Date('2026-09-08T10:00:00Z');

let pool: DbPool;
let claims: PostgresClaimRepository;
let processingDays: PostgresProcessingDayRepository;
let runs: PostgresRunRepository;

/** Управляемый источник каталога. */
class FakeCatalogSource implements GameCatalogSource {
  readonly source = 'metacritic' as const;
  readonly listingCalls: { section: string; page: number }[] = [];
  failListing: Error | null = null;

  constructor(
    private pages: Map<string, string[]>,
    private readonly gameFactory: (slug: string) => NormalizedGame | Error = (slug) =>
      makeGame(slug),
  ) {}

  setPages(pages: Map<string, string[]>): void {
    this.pages = pages;
  }

  async fetchListing(params: FetchListingParams): Promise<NormalizedListingPage> {
    const page = params.page ?? 1;
    this.listingCalls.push({ section: params.section, page });

    if (this.failListing) throw this.failListing;

    const key = params.section === 'new_releases' ? 'new_releases' : `browse:${page}`;
    const slugs = this.pages.get(key) ?? [];

    return {
      section: params.section,
      page,
      items: slugs.map((slug, index) => makeListingItem(slug, index)),
      skipped: 0,
    };
  }

  async fetchGame(params: FetchGameParams): Promise<NormalizedGame> {
    const result = this.gameFactory(params.sourceSlug);
    if (result instanceof Error) throw result;
    return result;
  }
}

function makeListingItem(slug: string, position: number): NormalizedListingItem {
  return {
    source: 'metacritic',
    sourceSlug: slug,
    title: `Игра ${slug}`,
    canonicalUrl: `https://www.metacritic.com/game/${slug}/`,
    coverImageUrl: null,
    position,
    releaseDate: null,
    platform: null,
  };
}

function makeGame(slug: string): NormalizedGame {
  return {
    source: 'metacritic',
    sourceSlug: slug,
    title: `Игра ${slug}`,
    canonicalUrl: `https://www.metacritic.com/game/${slug}/`,
    coverImageUrl: null,
    developer: 'Studio',
    developerStatus: 'resolved',
    publishers: ['Publisher'],
    description: null,
    videoUrl: null,
    genres: [],
    releaseDate: null,
    metascoreOverall: 80,
    userscoreOverall: null,
    userscoreStatus: 'disabled',
    platforms: [
      {
        platform: 'pc',
        platformName: 'PC',
        metascore: 80,
        metascoreScope: 'platform',
        userscore: null,
        userscoreScope: 'overall',
        criticCount: null,
      },
    ],
    parserVersion: 'test-v1',
  };
}

function slugRange(prefix: string, from: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${from + i}`);
}

interface HarnessOptions {
  readonly clock?: Date;
  readonly batchSize?: number;
  readonly concurrency?: number;
  readonly maxPagesPerRun?: number;
  readonly maxEmptyPages?: number;
  readonly leaseMinutes?: number;
}

function makeHarness(source: FakeCatalogSource, options: HarnessOptions = {}) {
  const dayProvider = new FixedProcessingDayProvider(options.clock ?? DAY_1);
  const events = new RecordingEventSink();

  const ingest = new IngestGameUseCase({
    catalogSource: source,
    games: new PostgresGameRepository(pool),
    platforms: new PostgresGamePlatformRepository(pool),
    unitOfWork: new PostgresUnitOfWork(pool),
  });

  const findCandidates = new FindNextClaimableGamesUseCase({
    catalogSource: source,
    claims,
    processingDays,
    maxPagesPerRun: options.maxPagesPerRun ?? 25,
    maxEmptyPages: options.maxEmptyPages ?? 3,
    leaseMinutes: options.leaseMinutes ?? 10,
  });

  // Эти тесты проверяют работу с заявками, арендой и пулом воркеров,
  // а не стадии отзывов и разбора: они подменяются успешными пустышками.
  const pipeline = new ProcessGamePipeline({
    ingestGame: ingest,
    syncCriticReviews: {
      execute: async () => ({ completeness: 'complete' }),
    } as never,
    syncUserReviews: {
      execute: async () => ({ completeness: 'complete' }),
    } as never,
    analyzeReviews: null,
    events,
    now: () => dayProvider.now(),
    analysisPlatform: 'default',
  });

  const useCase = new RunDailyProcessingUseCase({
    findCandidates,
    pipeline,
    claims,
    runs,
    runLock: new PostgresRunLock(pool),
    dayProvider,
    events,
    batchSize: options.batchSize ?? 20,
    workerConcurrency: options.concurrency ?? 4,
    leaseMinutes: options.leaseMinutes ?? 10,
    heartbeatIntervalMs: 60_000,
    maxAttempts: 3,
    // Таймеры-заглушки: heartbeat в тестах не должен создавать реальных
    // интервалов, иначе процесс не завершится.
    timers: {
      setInterval: () => null,
      clearInterval: () => undefined,
    },
  });

  return { useCase, events, dayProvider };
}

async function countClaims(day: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM daily_claims WHERE processing_day = $1',
    [day],
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
});

// ============================================================================
// DailyClaim — тесты 1-4
// ============================================================================

describe('Тест 1 — конкурентный claim одной игры', () => {
  it('один успех, остальные пропускаются', async () => {
    await processingDays.ensureDay('2026-09-07');
    const run = await runs.start('cron', { processingDay: '2026-09-07' });

    const results = await Promise.all([
      claims.claimBatch({
        day: '2026-09-07',
        runId: run.id,
        candidates: [{ source: 'metacritic', sourceSlug: 'contested' }],
        leaseMinutes: 10,
        limit: 5,
      }),
      claims.claimBatch({
        day: '2026-09-07',
        runId: run.id,
        candidates: [{ source: 'metacritic', sourceSlug: 'contested' }],
        leaseMinutes: 10,
        limit: 5,
      }),
    ]);

    const total = results.reduce((sum, r) => sum + r.length, 0);
    expect(total).toBe(1);
    expect(await countClaims('2026-09-07')).toBe(1);
  });
});

describe('Тест 2 — 20 конкурентных попыток на одну игру', () => {
  it('создаётся ровно один claim', async () => {
    await processingDays.ensureDay('2026-09-07');
    const run = await runs.start('cron', { processingDay: '2026-09-07' });

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        claims.claimBatch({
          day: '2026-09-07',
          runId: run.id,
          candidates: [{ source: 'metacritic', sourceSlug: 'hot-game' }],
          leaseMinutes: 10,
          limit: 1,
        }),
      ),
    );

    expect(results.reduce((sum, r) => sum + r.length, 0)).toBe(1);
    expect(await countClaims('2026-09-07')).toBe(1);
  });
});

describe('Тест 3 — два конкурентных запуска', () => {
  it('дублирующие claim невозможны', async () => {
    const pages = new Map([['new_releases', slugRange('game', 1, 20)]]);

    // Блокировка допускает лишь один активный запуск, поэтому проверяем
    // сам механизм claim: два независимых поиска по одному дню.
    await processingDays.ensureDay('2026-09-07');
    const runA = await runs.start('cron', { processingDay: '2026-09-07' });
    await runs.finish({ runId: runA.id, status: 'completed' });
    const runB = await runs.start('manual', { processingDay: '2026-09-07' });

    const source = new FakeCatalogSource(pages);
    const find = new FindNextClaimableGamesUseCase({
      catalogSource: source,
      claims,
      processingDays,
      maxPagesPerRun: 25,
      maxEmptyPages: 3,
      leaseMinutes: 10,
    });

    const [a, b] = await Promise.all([
      find.execute({ processingDay: '2026-09-07', runId: runA.id, targetCount: 20 }),
      find.execute({ processingDay: '2026-09-07', runId: runB.id, targetCount: 20 }),
    ]);

    // Суммарно захвачено не больше, чем есть игр
    expect(a.claims.length + b.claims.length).toBeLessThanOrEqual(20);
    expect(await countClaims('2026-09-07')).toBeLessThanOrEqual(20);

    // Ни одна игра не захвачена дважды
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM (
         SELECT source_slug FROM daily_claims WHERE processing_day = '2026-09-07'
         GROUP BY source_slug HAVING count(*) > 1
       ) dup`,
    );
    expect(Number(rows[0]!.count)).toBe(0);
  });
});

describe('Тест 4 — retry использует существующий claim', () => {
  it('не создаёт новую строку', async () => {
    await processingDays.ensureDay('2026-09-07');
    const run = await runs.start('cron', { processingDay: '2026-09-07' });

    await claims.claimBatch({
      day: '2026-09-07',
      runId: run.id,
      candidates: [{ source: 'metacritic', sourceSlug: 'retry-me' }],
      leaseMinutes: 10,
      limit: 1,
    });

    // Аренда истекла — reaper возвращает заявку в пул
    await pool.query(
      `UPDATE daily_claims SET lease_until = now() - interval '1 minute'
       WHERE source_slug = 'retry-me'`,
    );
    await claims.reapExpiredLeases({ now: new Date(), maxAttempts: 3 });

    const reclaimed = await claims.claimBatch({
      day: '2026-09-07',
      runId: run.id,
      candidates: [{ source: 'metacritic', sourceSlug: 'retry-me' }],
      leaseMinutes: 10,
      limit: 1,
    });

    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.attempts).toBeGreaterThan(1);
    // Строка та же самая
    expect(await countClaims('2026-09-07')).toBe(1);
  });
});

// ============================================================================
// Суточная обработка — тесты 5-12
// ============================================================================

describe('Тест 5 — новый день начинается с New Releases', () => {
  it('первый запуск использует раздел новинок', async () => {
    const source = new FakeCatalogSource(
      new Map([['new_releases', slugRange('nr', 1, 20)]]),
    );
    const { useCase, events } = makeHarness(source);

    const result = await useCase.execute({ trigger: 'cron' });

    expect(result.outcome).toBe('completed');
    expect(result.claimed).toBe(20);
    expect(source.listingCalls[0]!.section).toBe('new_releases');

    const completed = events.ofType('run_completed');
    expect(completed[0]!.strategy).toBe('new_releases');
  });
});

describe('Тест 6 — второй запуск того же дня использует Browse', () => {
  it('переходит к листингу See All', async () => {
    const source = new FakeCatalogSource(
      new Map([
        ['new_releases', slugRange('nr', 1, 20)],
        ['browse:1', slugRange('br', 1, 20)],
        ['browse:2', slugRange('br', 21, 20)],
      ]),
    );
    const { useCase } = makeHarness(source);

    await useCase.execute({ trigger: 'cron' });
    source.listingCalls.length = 0;

    const second = await useCase.execute({ trigger: 'cron' });

    expect(second.claimed).toBeGreaterThan(0);
    // Новинки повторно не запрашиваются: они уже обработаны сегодня
    expect(source.listingCalls.every((c) => c.section === 'browse_all_new')).toBe(true);
  });
});

describe('Тест 7 — новый день снова начинает с New Releases', () => {
  it('вчерашние claim не мешают сегодняшним', async () => {
    const source = new FakeCatalogSource(
      new Map([
        ['new_releases', slugRange('nr', 1, 20)],
        ['browse:1', slugRange('br', 1, 20)],
      ]),
    );

    const first = makeHarness(source, { clock: DAY_1 });
    await first.useCase.execute({ trigger: 'cron' });
    expect(await countClaims('2026-09-07')).toBe(20);

    // Наступили новые сутки
    source.listingCalls.length = 0;
    const second = makeHarness(source, { clock: DAY_2 });
    const result = await second.useCase.execute({ trigger: 'cron' });

    expect(result.processingDay).toBe('2026-09-08');
    expect(source.listingCalls[0]!.section).toBe('new_releases');
    // Те же игры заявлены заново — ключ включает сутки
    expect(result.claimed).toBe(20);
    expect(await countClaims('2026-09-08')).toBe(20);
    // Вчерашние заявки на месте
    expect(await countClaims('2026-09-07')).toBe(20);
  });
});

describe('Тест 8 — дубликаты в динамическом списке', () => {
  it('алгоритм добирает 20 уникальных заявок', async () => {
    // Страницы пересекаются, как реальный дрейфующий листинг
    const source = new FakeCatalogSource(
      new Map([
        ['new_releases', slugRange('g', 1, 5)],
        ['browse:1', slugRange('g', 1, 10)],
        ['browse:2', slugRange('g', 6, 10)],
        ['browse:3', slugRange('g', 11, 15)],
      ]),
    );
    const { useCase } = makeHarness(source);

    const result = await useCase.execute({ trigger: 'cron' });

    expect(result.claimed).toBe(20);
    // Ни одного дубля несмотря на пересечения
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(DISTINCT source_slug)::text AS count FROM daily_claims
       WHERE processing_day = '2026-09-07'`,
    );
    expect(Number(rows[0]!.count)).toBe(20);
  });
});

describe('Тест 9 — дрейф и пересечение страниц', () => {
  it('не мешает добрать нужное количество', async () => {
    const source = new FakeCatalogSource(
      new Map([
        ['new_releases', slugRange('d', 1, 8)],
        // Страница 1 и 2 сильно пересекаются — имитация дрейфа
        ['browse:1', slugRange('d', 5, 10)],
        ['browse:2', slugRange('d', 8, 10)],
        ['browse:3', slugRange('d', 15, 10)],
      ]),
    );
    const { useCase, events } = makeHarness(source);

    const result = await useCase.execute({ trigger: 'cron' });

    expect(result.claimed).toBe(20);
    // Пропущенные кандидаты зафиксированы как уже заявленные
    const skipped = events.ofType('claim_skipped');
    expect(skipped.length).toBeGreaterThan(0);
  });
});

describe('Тест 10 — источник отдаёт одну и ту же страницу', () => {
  it('нет бесконечного цикла', async () => {
    const repeated = slugRange('same', 1, 5);
    const pages = new Map<string, string[]>([['new_releases', repeated]]);
    // Любая страница browse возвращает тот же набор
    for (let i = 1; i <= 30; i += 1) pages.set(`browse:${i}`, repeated);

    const source = new FakeCatalogSource(pages);
    const { useCase } = makeHarness(source, { maxPagesPerRun: 25, maxEmptyPages: 3 });

    const result = await useCase.execute({ trigger: 'cron' });

    // Завершился, а не завис
    expect(result.outcome).toBe('completed');
    expect(result.claimed).toBe(5);
    // Число обращений ограничено защитой
    expect(source.listingCalls.length).toBeLessThanOrEqual(26);
  }, 30_000);
});

describe('Тест 11 — источник исчерпан раньше 20 игр', () => {
  it('запуск завершается с частичным результатом', async () => {
    const source = new FakeCatalogSource(
      new Map([
        ['new_releases', slugRange('few', 1, 3)],
        ['browse:1', []],
        ['browse:2', []],
        ['browse:3', []],
      ]),
    );
    const { useCase, events } = makeHarness(source);

    const result = await useCase.execute({ trigger: 'cron' });

    expect(result.outcome).toBe('completed');
    expect(result.claimed).toBe(3);
    expect(result.stopReason).toBe('source_exhausted');

    const completed = events.ofType('run_completed');
    expect(completed[0]!.stopReason).toBe('source_exhausted');
  });
});

describe('Тест 12 — ошибка источника', () => {
  it('запуск фиксирует неудачу и не зависает', async () => {
    const source = new FakeCatalogSource(new Map());
    source.failListing = new IngestionError('network', 'Соединение потеряно', {});

    const { useCase, events } = makeHarness(source);
    const result = await useCase.execute({ trigger: 'cron' });

    // Кандидатов нет, но запуск корректно завершён
    expect(result.claimed).toBe(0);
    expect(result.stopReason).toBe('source_error');
    expect(events.ofType('run_completed')).toHaveLength(1);
  });

  it('блокировка источника прерывает запуск', async () => {
    const source = new FakeCatalogSource(new Map());
    source.failListing = new IngestionError('blocked', 'Доступ запрещён', {
      status: 403,
    });

    const { useCase, events } = makeHarness(source);
    const result = await useCase.execute({ trigger: 'cron' });

    expect(result.outcome).toBe('failed');
    const failed = events.ofType('run_failed');
    expect(failed[0]!.errorCategory).toBe('blocked');

    // Статус запуска отличается от обычной ошибки
    const run = await runs.findById(result.runId!);
    expect(run!.status).toBe('blocked');
  });
});

// ============================================================================
// Воркеры — тесты 13-18
// ============================================================================

describe('Тест 13 — ограничение параллелизма', () => {
  it('одновременно работает не больше заданного числа воркеров', async () => {
    let active = 0;
    let peak = 0;

    const source = new FakeCatalogSource(
      new Map([['new_releases', slugRange('conc', 1, 12)]]),
      (slug) => makeGame(slug),
    );

    // Отслеживаем пик параллелизма через задержку внутри fetchGame
    const original = source.fetchGame.bind(source);
    source.fetchGame = async (params: FetchGameParams) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return original(params);
    };

    const { useCase } = makeHarness(source, { concurrency: 3, batchSize: 12 });
    await useCase.execute({ trigger: 'cron' });

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  }, 30_000);
});

describe('Тест 14 — падение одного воркера', () => {
  it('остальные продолжают работу', async () => {
    const source = new FakeCatalogSource(
      new Map([['new_releases', slugRange('mix', 1, 6)]]),
      (slug) =>
        slug === 'mix-3'
          ? new IngestionError('network', 'Сбой на одной игре', {})
          : makeGame(slug),
    );

    const { useCase, events } = makeHarness(source, { batchSize: 6 });
    const result = await useCase.execute({ trigger: 'cron' });

    expect(result.claimed).toBe(6);
    expect(result.processed).toBe(5);
    expect(result.failed).toBe(1);

    const failedEvents = events.ofType('game_processing_failed');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]!.sourceSlug).toBe('mix-3');

    // Заявка упавшей игры помечена, остальные завершены
    const failedClaim = await claims.find('2026-09-07', 'metacritic', 'mix-3');
    expect(failedClaim!.status).toBe('failed');
    expect(failedClaim!.lastError).toContain('Сбой');

    const okClaim = await claims.find('2026-09-07', 'metacritic', 'mix-1');
    expect(okClaim!.status).toBe('done');
  });
});

describe('Тест 15-17 — аренда и восстановление', () => {
  it('продление аренды сохраняет заявку за воркером', async () => {
    await processingDays.ensureDay('2026-09-07');
    const run = await runs.start('cron', { processingDay: '2026-09-07' });

    const [claim] = await claims.claimBatch({
      day: '2026-09-07',
      runId: run.id,
      candidates: [{ source: 'metacritic', sourceSlug: 'long-work' }],
      leaseMinutes: 1,
      limit: 1,
    });
    const initial = claim!.leaseUntil!;

    await claims.extendLease({
      day: '2026-09-07',
      source: 'metacritic',
      sourceSlug: 'long-work',
      leaseMinutes: 30,
      runId: run.id,
    });

    const after = await claims.find('2026-09-07', 'metacritic', 'long-work');
    expect(after!.leaseUntil!.getTime()).toBeGreaterThan(initial.getTime());
  });

  it('истёкшая аренда восстанавливается', async () => {
    await processingDays.ensureDay('2026-09-07');
    const run = await runs.start('cron', { processingDay: '2026-09-07' });

    await claims.claimBatch({
      day: '2026-09-07',
      runId: run.id,
      candidates: [{ source: 'metacritic', sourceSlug: 'dead-worker' }],
      leaseMinutes: 10,
      limit: 1,
    });

    await pool.query(
      `UPDATE daily_claims SET lease_until = now() - interval '1 minute'
       WHERE source_slug = 'dead-worker'`,
    );

    const reaped = await claims.reapExpiredLeases({ now: new Date(), maxAttempts: 3 });
    expect(reaped.revived).toBe(1);

    const claim = await claims.find('2026-09-07', 'metacritic', 'dead-worker');
    expect(claim!.status).toBe('pending');
  });

  it('ЖИВАЯ аренда не забирается reaper', async () => {
    await processingDays.ensureDay('2026-09-07');
    const run = await runs.start('cron', { processingDay: '2026-09-07' });

    await claims.claimBatch({
      day: '2026-09-07',
      runId: run.id,
      candidates: [{ source: 'metacritic', sourceSlug: 'alive' }],
      leaseMinutes: 30,
      limit: 1,
    });

    const reaped = await claims.reapExpiredLeases({ now: new Date(), maxAttempts: 3 });
    expect(reaped.revived).toBe(0);

    const claim = await claims.find('2026-09-07', 'metacritic', 'alive');
    expect(claim!.status).toBe('claimed');
  });

  it('восстановление использует ТУ ЖЕ заявку', async () => {
    await processingDays.ensureDay('2026-09-07');
    const run = await runs.start('cron', { processingDay: '2026-09-07' });

    await claims.claimBatch({
      day: '2026-09-07',
      runId: run.id,
      candidates: [{ source: 'metacritic', sourceSlug: 'same-row' }],
      leaseMinutes: 10,
      limit: 1,
    });

    await pool.query(
      `UPDATE daily_claims SET lease_until = now() - interval '1 minute'
       WHERE source_slug = 'same-row'`,
    );
    await claims.reapExpiredLeases({ now: new Date(), maxAttempts: 3 });

    const reclaimed = await claims.claimBatch({
      day: '2026-09-07',
      runId: run.id,
      candidates: [{ source: 'metacritic', sourceSlug: 'same-row' }],
      leaseMinutes: 10,
      limit: 1,
    });

    expect(reclaimed).toHaveLength(1);
    expect(await countClaims('2026-09-07')).toBe(1);
  });

  it('исчерпание попыток переводит заявку в failed', async () => {
    await processingDays.ensureDay('2026-09-07');
    const run = await runs.start('cron', { processingDay: '2026-09-07' });

    await claims.claimBatch({
      day: '2026-09-07',
      runId: run.id,
      candidates: [{ source: 'metacritic', sourceSlug: 'doomed' }],
      leaseMinutes: 10,
      limit: 1,
    });
    await pool.query(
      `UPDATE daily_claims SET lease_until = now() - interval '1 minute', attempts = 3
       WHERE source_slug = 'doomed'`,
    );

    const reaped = await claims.reapExpiredLeases({ now: new Date(), maxAttempts: 3 });
    expect(reaped.failed).toBe(1);

    const claim = await claims.find('2026-09-07', 'metacritic', 'doomed');
    expect(claim!.status).toBe('failed');
  });
});

// ============================================================================
// Запуски — тесты 19-22
// ============================================================================

describe('Тест 20 — блокировка запрещает параллельные запуски', () => {
  it('второй запуск пропускается', async () => {
    const source = new FakeCatalogSource(
      new Map([['new_releases', slugRange('lock', 1, 5)]]),
    );

    // Занимаем блокировку сторонним соединением
    const lock = new PostgresRunLock(pool);
    const held = await lock.tryAcquire();
    expect(held).not.toBeNull();

    try {
      const { useCase, events } = makeHarness(source, { batchSize: 5 });
      const result = await useCase.execute({ trigger: 'cron' });

      expect(result.outcome).toBe('skipped');
      expect(result.runId).toBeNull();
      expect(events.ofType('run_skipped')[0]!.reason).toBe('already_running');

      // Запуск даже не создавался
      const { rows } = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM runs',
      );
      expect(Number(rows[0]!.count)).toBe(0);
    } finally {
      await held!.release();
    }
  });
});

describe('Тест 21 — освобождение блокировки', () => {
  it('после завершения запуска следующий стартует', async () => {
    const source = new FakeCatalogSource(
      new Map([
        ['new_releases', slugRange('seq', 1, 3)],
        ['browse:1', slugRange('seq', 4, 3)],
        ['browse:2', []],
        ['browse:3', []],
        ['browse:4', []],
      ]),
    );
    const { useCase } = makeHarness(source, { batchSize: 3 });

    const first = await useCase.execute({ trigger: 'cron' });
    expect(first.outcome).toBe('completed');

    // Блокировка освобождена — второй запуск проходит
    const second = await useCase.execute({ trigger: 'cron' });
    expect(second.outcome).toBe('completed');
  });
});

describe('Тест 22 — graceful shutdown', () => {
  it('уже начатые задачи доводятся до конца', async () => {
    const controller = new AbortController();
    let started = 0;

    const source = new FakeCatalogSource(
      new Map([['new_releases', slugRange('shut', 1, 8)]]),
      (slug) => makeGame(slug),
    );

    const original = source.fetchGame.bind(source);
    source.fetchGame = async (params: FetchGameParams) => {
      started += 1;
      // Отменяем после запуска первых задач
      if (started === 2) controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 10));
      return original(params);
    };

    const { useCase } = makeHarness(source, { concurrency: 2, batchSize: 8 });
    const result = await useCase.execute({
      trigger: 'cron',
      signal: controller.signal,
    });

    // Часть задач пропущена, но начатые завершились без потерь
    expect(result.processed + result.failed + result.skipped).toBe(result.claimed);
    expect(result.skipped).toBeGreaterThan(0);
  }, 30_000);
});

describe('Наблюдаемость запуска', () => {
  it('публикуется полная последовательность событий', async () => {
    const source = new FakeCatalogSource(
      new Map([['new_releases', slugRange('obs', 1, 3)]]),
    );
    const { useCase, events } = makeHarness(source, { batchSize: 3 });

    await useCase.execute({ trigger: 'cron' });

    const types = events.events.map((e) => e.type);
    expect(types).toContain('run_started');
    expect(types).toContain('claim_created');
    expect(types).toContain('game_processing_started');
    expect(types).toContain('game_processing_completed');
    expect(types).toContain('run_completed');
  });

  it('запуск сохраняет сутки, стратегию и курсор', async () => {
    const source = new FakeCatalogSource(
      new Map([['new_releases', slugRange('ctx', 1, 5)]]),
    );
    const { useCase } = makeHarness(source, { batchSize: 5 });

    const result = await useCase.execute({ trigger: 'cron' });
    const run = await runs.findById(result.runId!);

    expect(run!.processingDay).toBe('2026-09-07');
    expect(run!.sourceStrategy).toBe('new_releases');
    expect(run!.pagesScanned).toBeGreaterThan(0);
    expect(run!.claimedCount).toBe(5);
    expect(run!.processedCount).toBe(5);
  });
});
