import type { DbPool } from '../../../shared/db/pool.js';
import type { GameSource } from '../../catalog/domain/game.js';
import type {
  ClaimStatus,
  DailyClaim,
  ProcessingDay,
  ProcessingPhase,
  StageMap,
  StageName,
  StageState,
} from '../domain/claim.js';
import type {
  ClaimCandidate,
  ClaimRepository,
  ProcessingDayRepository,
  ProcessingDayUpdate,
  RunClaimCounters,
  RunStageCounters,
} from '../domain/claim-repository.js';

interface ProcessingDayRow {
  day: string;
  phase: string;
  browse_page: number;
  new_releases_done: boolean;
  claimed_count: number;
}

interface ClaimRow {
  processing_day: string;
  source: string;
  source_slug: string;
  game_id: string | null;
  run_id: string | null;
  status: string;
  claimed_at: Date | null;
  lease_until: Date | null;
  attempts: number;
  stages: StageMap;
  last_error: string | null;
  completed_at: Date | null;
}

function mapDay(row: ProcessingDayRow): ProcessingDay {
  return {
    day: row.day,
    phase: row.phase as ProcessingPhase,
    browsePage: row.browse_page,
    newReleasesDone: row.new_releases_done,
    claimedCount: row.claimed_count,
  };
}

function mapClaim(row: ClaimRow): DailyClaim {
  return {
    processingDay: row.processing_day,
    source: row.source as GameSource,
    sourceSlug: row.source_slug,
    gameId: row.game_id,
    runId: row.run_id,
    status: row.status as ClaimStatus,
    claimedAt: row.claimed_at,
    leaseUntil: row.lease_until,
    attempts: row.attempts,
    stages: row.stages ?? {},
    lastError: row.last_error,
    completedAt: row.completed_at,
  };
}

const CLAIM_COLUMNS = `
  processing_day, source, source_slug, game_id, run_id, status,
  claimed_at, lease_until, attempts, stages, last_error, completed_at
`;

export class PostgresProcessingDayRepository implements ProcessingDayRepository {
  constructor(private readonly pool: DbPool) {}

  /**
   * Создаёт план дня при отсутствии.
   *
   * ON CONFLICT DO NOTHING делает вызов идемпотентным: одновременный старт
   * двух воркеров не приводит к ошибке и не создаёт двух планов.
   */
  async ensureDay(day: string): Promise<ProcessingDay> {
    await this.pool.query(
      `INSERT INTO processing_days (day, phase, browse_page, new_releases_done)
       VALUES ($1, 'new_releases', 1, FALSE)
       ON CONFLICT (day) DO NOTHING`,
      [day],
    );

    const found = await this.find(day);
    if (!found) throw new Error(`Не удалось создать план дня ${day}`);
    return found;
  }

  async update(day: string, patch: ProcessingDayUpdate): Promise<ProcessingDay> {
    const sets: string[] = [];
    const params: unknown[] = [day];

    if (patch.phase !== undefined) {
      params.push(patch.phase);
      sets.push(`phase = $${params.length}`);
    }
    if (patch.browsePage !== undefined) {
      params.push(patch.browsePage);
      sets.push(`browse_page = $${params.length}`);
    }
    if (patch.newReleasesDone !== undefined) {
      params.push(patch.newReleasesDone);
      sets.push(`new_releases_done = $${params.length}`);
    }

    if (sets.length === 0) {
      const current = await this.find(day);
      if (!current) throw new Error(`План дня ${day} не найден`);
      return current;
    }

    sets.push('updated_at = now()');

    const { rows } = await this.pool.query<ProcessingDayRow>(
      `UPDATE processing_days SET ${sets.join(', ')}
       WHERE day = $1
       RETURNING day, phase, browse_page, new_releases_done, claimed_count`,
      params,
    );
    const row = rows[0];
    if (!row) throw new Error(`План дня ${day} не найден`);
    return mapDay(row);
  }

  async find(day: string): Promise<ProcessingDay | null> {
    const { rows } = await this.pool.query<ProcessingDayRow>(
      `SELECT day, phase, browse_page, new_releases_done, claimed_count
       FROM processing_days WHERE day = $1`,
      [day],
    );
    const row = rows[0];
    return row ? mapDay(row) : null;
  }
}

export class PostgresClaimRepository implements ClaimRepository {
  constructor(private readonly pool: DbPool) {}

  /**
   * Атомарный захват игр (ADR-0004).
   *
   * Ключевой механизм корректности всего сервиса:
   * - INSERT ... ON CONFLICT DO NOTHING RETURNING возвращает ТОЛЬКО строки,
   *   вставленные этим вызовом. Уже заявленные сегодня игры не возвращаются;
   * - PK (processing_day, source, source_slug) делает двойной захват физически
   *   невозможным — при гонке побеждает ровно один воркер;
   * - повторный запуск в те же сутки не создаёт дубль.
   *
   * Отдельно обрабатывается 'pending': заявки, возвращённые reaper'ом, нужно
   * захватывать через UPDATE, поскольку строка уже существует.
   */
  async claimBatch(params: {
    day: string;
    runId: string;
    candidates: readonly ClaimCandidate[];
    leaseMinutes: number;
    limit: number;
  }): Promise<readonly DailyClaim[]> {
    if (params.candidates.length === 0 || params.limit <= 0) return [];

    const claimed: DailyClaim[] = [];
    const lease = `${params.leaseMinutes} minutes`;

    // 1) Сначала подбираем заявки, освобождённые reaper'ом (retry без дубля).
    const slugs = params.candidates.map((c) => c.sourceSlug);
    const sources = [...new Set(params.candidates.map((c) => c.source))];

    const revived = await this.pool.query<ClaimRow>(
      `UPDATE daily_claims
       SET status      = 'claimed',
           run_id      = $1,
           claimed_at  = now(),
           lease_until = now() + $2::interval,
           attempts    = attempts + 1,
           updated_at  = now()
       WHERE (processing_day, source, source_slug) IN (
         SELECT processing_day, source, source_slug
         FROM daily_claims
         WHERE processing_day = $3
           AND source = ANY($4::text[])
           AND source_slug = ANY($5::text[])
           AND status = 'pending'
         ORDER BY source_slug
         LIMIT $6
         FOR UPDATE SKIP LOCKED
       )
       RETURNING ${CLAIM_COLUMNS}`,
      [params.runId, lease, params.day, sources, slugs, params.limit],
    );
    claimed.push(...revived.rows.map(mapClaim));

    // 2) Затем захватываем новые слаги, пока не наберём limit.
    //
    // LIMIT применяется ПОСЛЕ отсева уже заявленных (WHERE NOT EXISTS),
    // поэтому вставляется ровно нужное количество новых заявок. Ни лишних
    // захватов, ни последующего удаления не требуется.
    //
    // ON CONFLICT остаётся страховкой от гонки: между проверкой NOT EXISTS
    // и вставкой другой процесс может успеть создать ту же строку.
    // Тогда наш INSERT просто вернёт меньше строк — недостача добирается
    // со следующей страницы листинга.
    const remaining = params.limit - claimed.length;
    if (remaining > 0) {
      const alreadyClaimed = new Set(claimed.map((c) => c.sourceSlug));
      const fresh = params.candidates.filter((c) => !alreadyClaimed.has(c.sourceSlug));

      if (fresh.length > 0) {
        const { rows } = await this.pool.query<ClaimRow>(
          `INSERT INTO daily_claims (
             processing_day, source, source_slug, run_id,
             status, claimed_at, lease_until, attempts
           )
           SELECT $1, c.source, c.slug, $2, 'claimed', now(), now() + $3::interval, 1
           FROM unnest($4::text[], $5::text[]) AS c(source, slug)
           WHERE NOT EXISTS (
             SELECT 1 FROM daily_claims existing
             WHERE existing.processing_day = $1
               AND existing.source = c.source
               AND existing.source_slug = c.slug
           )
           LIMIT $6
           ON CONFLICT (processing_day, source, source_slug) DO NOTHING
           RETURNING ${CLAIM_COLUMNS}`,
          [
            params.day,
            params.runId,
            lease,
            fresh.map((c) => c.source),
            fresh.map((c) => c.sourceSlug),
            remaining,
          ],
        );

        claimed.push(...rows.map(mapClaim));
      }
    }

    if (claimed.length > 0) {
      await this.pool.query(
        `UPDATE processing_days
         SET claimed_count = claimed_count + $2, updated_at = now()
         WHERE day = $1`,
        [params.day, claimed.length],
      );
    }

    return claimed;
  }

  async markDone(params: {
    day: string;
    source: GameSource;
    sourceSlug: string;
    gameId: string | null;
    stages: StageMap;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE daily_claims
       SET status       = 'done',
           game_id      = COALESCE($4, game_id),
           stages       = $5::jsonb,
           lease_until  = NULL,
           completed_at = now(),
           last_error   = NULL,
           updated_at   = now()
       WHERE processing_day = $1 AND source = $2 AND source_slug = $3`,
      [params.day, params.source, params.sourceSlug, params.gameId, JSON.stringify(params.stages)],
    );
  }

  async markFailed(params: {
    day: string;
    source: GameSource;
    sourceSlug: string;
    error: string;
    stages: StageMap;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE daily_claims
       SET status      = 'failed',
           stages      = $5::jsonb,
           lease_until = NULL,
           last_error  = $4,
           updated_at  = now()
       WHERE processing_day = $1 AND source = $2 AND source_slug = $3`,
      [
        params.day,
        params.source,
        params.sourceSlug,
        params.error.slice(0, 2000),
        JSON.stringify(params.stages),
      ],
    );
  }

  /** Сохраняет результат стадии, сливая его с уже записанными (jsonb ||). */
  async recordStage(params: {
    day: string;
    source: GameSource;
    sourceSlug: string;
    stage: StageName;
    state: StageState;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE daily_claims
       SET stages     = stages || jsonb_build_object($4::text, $5::jsonb),
           updated_at = now()
       WHERE processing_day = $1 AND source = $2 AND source_slug = $3`,
      [
        params.day,
        params.source,
        params.sourceSlug,
        params.stage,
        JSON.stringify(params.state),
      ],
    );
  }

  /**
   * Условное продление аренды.
   *
   * Три условия в WHERE исключают гонку с reaper:
   *   status = 'claimed'      — заявка не завершена и не возвращена в пул;
   *   lease_until > now()     — аренда ЕЩЁ НЕ истекла, значит reaper её
   *                             не отбирал (он работает по lease_until < now);
   *   run_id = $5             — заявка принадлежит именно этому запуску.
   *
   * Проверка срока обязательна: без неё воркер, «проспавший» истечение
   * аренды, воскресил бы заявку, которую reaper уже вернул в пул, — и та
   * обрабатывалась бы двумя воркерами одновременно.
   *
   * Возвращает false, если заявка воркеру больше не принадлежит.
   */
  async extendLease(params: {
    day: string;
    source: GameSource;
    sourceSlug: string;
    leaseMinutes: number;
    runId: string;
  }): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE daily_claims
       SET lease_until = now() + $4::interval, updated_at = now()
       WHERE processing_day = $1 AND source = $2 AND source_slug = $3
         AND status = 'claimed'
         AND lease_until > now()
         AND run_id = $5`,
      [
        params.day,
        params.source,
        params.sourceSlug,
        `${params.leaseMinutes} minutes`,
        params.runId,
      ],
    );

    return (rowCount ?? 0) > 0;
  }

  /**
   * Reaper: восстанавливает заявки после падения воркера.
   *
   * ВАЖНО: выполняется UPDATE существующих строк, а не INSERT — требование
   * «retry/recovery без duplicate claim» (ADR-0004).
   *
   * Заявки с исчерпанными попытками переводятся в 'failed', чтобы не занимать
   * место в батче, оставаясь видимыми в мониторинге.
   */
  async reapExpiredLeases(params: { now: Date; maxAttempts: number }): Promise<{
    revived: number;
    failed: number;
  }> {
    const failedResult = await this.pool.query(
      `UPDATE daily_claims
       SET status      = 'failed',
           lease_until = NULL,
           last_error  = COALESCE(last_error, 'Превышено число попыток после истечения аренды'),
           updated_at  = now()
       WHERE status = 'claimed'
         AND lease_until < $1
         AND attempts >= $2`,
      [params.now, params.maxAttempts],
    );

    const revivedResult = await this.pool.query(
      `UPDATE daily_claims
       SET status      = 'pending',
           run_id      = NULL,
           lease_until = NULL,
           last_error  = 'Аренда истекла: воркер, вероятно, завершился аварийно',
           updated_at  = now()
       WHERE status = 'claimed'
         AND lease_until < $1
         AND attempts < $2`,
      [params.now, params.maxAttempts],
    );

    return {
      revived: revivedResult.rowCount ?? 0,
      failed: failedResult.rowCount ?? 0,
    };
  }

  async find(
    day: string,
    source: GameSource,
    sourceSlug: string,
  ): Promise<DailyClaim | null> {
    const { rows } = await this.pool.query<ClaimRow>(
      `SELECT ${CLAIM_COLUMNS} FROM daily_claims
       WHERE processing_day = $1 AND source = $2 AND source_slug = $3`,
      [day, source, sourceSlug],
    );
    const row = rows[0];
    return row ? mapClaim(row) : null;
  }

  async findClaimedSlugs(day: string, source: GameSource): Promise<readonly string[]> {
    const { rows } = await this.pool.query<{ source_slug: string }>(
      `SELECT source_slug FROM daily_claims
       WHERE processing_day = $1 AND source = $2`,
      [day, source],
    );
    return rows.map((r) => r.source_slug);
  }

  async countByRun(runId: string): Promise<RunClaimCounters> {
    // 'partial' выводится здесь, а не хранится: заявка выполнена, но
    // необязательная стадия не удалась или была пропущена. Критичные
    // стадии (fetchGame, fetchReviews) в расчёт не входят — их провал
    // переводит заявку в 'failed' (решение OQ-3A-4).
    const { rows } = await this.pool.query<{
      total: string;
      succeeded: string;
      partial: string;
      failed: string;
      in_progress: string;
    }>(
      `WITH classified AS (
         SELECT
           status,
           EXISTS (
             SELECT 1
             FROM jsonb_each(stages) AS stage(name, state)
             WHERE stage.name NOT IN ('fetchGame', 'fetchReviews')
               AND state->>'status' IN ('failed', 'skipped')
           ) AS has_optional_gap
         FROM daily_claims
         WHERE run_id = $1
       )
       SELECT
         count(*)::text AS total,
         count(*) FILTER (
           WHERE status = 'done' AND NOT has_optional_gap
         )::text AS succeeded,
         count(*) FILTER (
           WHERE status = 'done' AND has_optional_gap
         )::text AS partial,
         count(*) FILTER (WHERE status = 'failed')::text AS failed,
         count(*) FILTER (WHERE status IN ('pending', 'claimed'))::text AS in_progress
       FROM classified`,
      [runId],
    );

    const row = rows[0];
    return {
      total: Number(row?.total ?? 0),
      succeeded: Number(row?.succeeded ?? 0),
      partial: Number(row?.partial ?? 0),
      failed: Number(row?.failed ?? 0),
      inProgress: Number(row?.in_progress ?? 0),
    };
  }

  async countStagesByRun(runId: string): Promise<readonly RunStageCounters[]> {
    // Стадии хранятся в jsonb; jsonb_each разворачивает их в строки,
    // после чего считаем каждое состояние отдельно.
    const { rows } = await this.pool.query<{
      stage: string;
      done: string;
      failed: string;
      skipped: string;
      pending: string;
    }>(
      `SELECT stage.name AS stage,
              count(*) FILTER (WHERE stage.state->>'status' = 'done')::text    AS done,
              count(*) FILTER (WHERE stage.state->>'status' = 'failed')::text  AS failed,
              count(*) FILTER (WHERE stage.state->>'status' = 'skipped')::text AS skipped,
              count(*) FILTER (WHERE stage.state->>'status' = 'pending')::text AS pending
       FROM daily_claims c,
            jsonb_each(c.stages) AS stage(name, state)
       WHERE c.run_id = $1
       GROUP BY stage.name
       ORDER BY stage.name`,
      [runId],
    );

    return rows.map((row) => ({
      stage: row.stage,
      done: Number(row.done),
      failed: Number(row.failed),
      skipped: Number(row.skipped),
      pending: Number(row.pending),
    }));
  }

  async countByStatus(day: string): Promise<Record<ClaimStatus, number>> {
    const { rows } = await this.pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM daily_claims
       WHERE processing_day = $1 GROUP BY status`,
      [day],
    );

    const result: Record<ClaimStatus, number> = {
      pending: 0,
      claimed: 0,
      done: 0,
      failed: 0,
    };
    for (const row of rows) {
      result[row.status as ClaimStatus] = Number(row.count);
    }
    return result;
  }
}
