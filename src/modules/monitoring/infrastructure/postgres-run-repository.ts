import type { DbPool } from '../../../shared/db/pool.js';
import type {
  EventLevel,
  Run,
  RunCounters,
  RunEvent,
  RunRepository,
  RunStatus,
  RunTrigger,
  RunDailyContext,
  StartRunOptions,
} from '../domain/run.js';

interface RunRow {
  id: string;
  trigger: string;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  planned_count: number;
  claimed_count: number;
  processed_count: number;
  failed_count: number;
  error: string | null;
  heartbeat_at: Date;
  owner_id: string | null;
  lock_key: string | null;
  recovered_at: Date | null;
  recovery_reason: string | null;
  processing_day: string | null;
  source_strategy: string | null;
  last_page_hint: number | null;
  pages_scanned: number;
}

interface EventRow {
  id: string;
  run_id: string;
  ts: Date;
  level: string;
  stage: string | null;
  source_slug: string | null;
  message: string;
  payload: Record<string, unknown> | null;
}

function mapRun(row: RunRow): Run {
  return {
    id: row.id,
    trigger: row.trigger as RunTrigger,
    status: row.status as RunStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    plannedCount: row.planned_count,
    claimedCount: row.claimed_count,
    processedCount: row.processed_count,
    failedCount: row.failed_count,
    error: row.error,
    heartbeatAt: row.heartbeat_at,
    ownerId: row.owner_id,
    // BIGINT приходит строкой — приводим явно, значение заведомо в пределах
    // безопасного целого.
    lockKey: row.lock_key === null ? null : Number(row.lock_key),
    recoveredAt: row.recovered_at,
    recoveryReason: row.recovery_reason,
    processingDay: row.processing_day,
    sourceStrategy: row.source_strategy,
    lastPageHint: row.last_page_hint,
    pagesScanned: row.pages_scanned,
  };
}

function mapEvent(row: EventRow): RunEvent {
  return {
    // BIGSERIAL приходит строкой — сохраняем как строку, чтобы не терять
    // точность на больших значениях курсора.
    id: String(row.id),
    runId: row.run_id,
    ts: row.ts,
    level: row.level as EventLevel,
    stage: row.stage,
    sourceSlug: row.source_slug,
    message: row.message,
    payload: row.payload,
  };
}

const RUN_COLUMNS = `
  id, trigger, status, started_at, finished_at,
  planned_count, claimed_count, processed_count, failed_count, error,
  heartbeat_at, owner_id, lock_key, recovered_at, recovery_reason,
  processing_day, source_strategy, last_page_hint, pages_scanned
`;

const EVENT_COLUMNS = `id, run_id, ts, level, stage, source_slug, message, payload`;

export class PostgresRunRepository implements RunRepository {
  constructor(private readonly pool: DbPool) {}

  async start(trigger: RunTrigger, options: StartRunOptions = {}): Promise<Run> {
    const { rows } = await this.pool.query<RunRow>(
      `INSERT INTO runs (trigger, status, owner_id, lock_key, heartbeat_at, processing_day)
       VALUES ($1, 'running', $2, $3, now(), $4)
       RETURNING ${RUN_COLUMNS}`,
      [
        trigger,
        options.ownerId ?? null,
        options.lockKey ?? null,
        options.processingDay ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('Не удалось создать запуск');
    return mapRun(row);
  }

  async updateDailyContext(runId: string, context: RunDailyContext): Promise<void> {
    await this.pool.query(
      `UPDATE runs
       SET source_strategy = COALESCE($2, source_strategy),
           last_page_hint  = COALESCE($3, last_page_hint),
           pages_scanned   = COALESCE($4, pages_scanned)
       WHERE id = $1`,
      [
        runId,
        context.sourceStrategy ?? null,
        context.lastPageHint ?? null,
        context.pagesScanned ?? null,
      ],
    );
  }

  async touchHeartbeat(runId: string): Promise<void> {
    await this.pool.query(
      `UPDATE runs SET heartbeat_at = now() WHERE id = $1 AND status = 'running'`,
      [runId],
    );
  }

  /**
   * Отбирает кандидатов на восстановление.
   *
   * Порядок проверки соответствует ADR-0010: сперва достоверный признак
   * (наличие advisory lock), и лишь для записей без lock_key — heartbeat.
   */
  async findOrphanedRuns(params: {
    heartbeatTimeoutMinutes: number;
    isLockHeld: (lockKey: number) => Promise<boolean>;
  }): Promise<readonly Run[]> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE status = 'running'`,
    );

    const orphaned: Run[] = [];
    for (const row of rows) {
      const run = mapRun(row);

      if (run.lockKey !== null) {
        // Основной критерий: держатель блокировки исчез => процесс мёртв.
        const held = await params.isLockHeld(run.lockKey);
        if (!held) orphaned.push(run);
        continue;
      }

      // Запасной критерий для записей без lock_key.
      const cutoff = Date.now() - params.heartbeatTimeoutMinutes * 60_000;
      if (run.heartbeatAt.getTime() < cutoff) orphaned.push(run);
    }

    return orphaned;
  }

  /**
   * Переводит осиротевший запуск в 'failed'.
   *
   * Условие `status = 'running'` внутри UPDATE — то, что делает операцию
   * идемпотентной и защищает от одновременного восстановления двумя
   * процессами: строка блокируется СУБД, второй увидит уже изменённый статус
   * и получит пустой результат.
   *
   * Статус именно 'failed', а не 'completed': работа не была доведена до конца.
   */
  async markRecovered(params: { runId: string; reason: string }): Promise<boolean> {
    const { rows } = await this.pool.query<{ id: string }>(
      `UPDATE runs
       SET status          = 'failed',
           finished_at     = now(),
           recovered_at    = now(),
           recovery_reason = $2,
           error           = COALESCE(error, $2)
       WHERE id = $1 AND status = 'running'
       RETURNING id`,
      [params.runId, params.reason.slice(0, 2000)],
    );
    return rows.length > 0;
  }

  async finish(params: {
    runId: string;
    status: Exclude<RunStatus, 'running'>;
    counters?: RunCounters;
    error?: string | null;
  }): Promise<Run> {
    const c = params.counters ?? {};
    const { rows } = await this.pool.query<RunRow>(
      `UPDATE runs
       SET status          = $2,
           finished_at     = now(),
           planned_count   = COALESCE($3, planned_count),
           claimed_count   = COALESCE($4, claimed_count),
           processed_count = COALESCE($5, processed_count),
           failed_count    = COALESCE($6, failed_count),
           error           = $7
       WHERE id = $1
       RETURNING ${RUN_COLUMNS}`,
      [
        params.runId,
        params.status,
        c.plannedCount ?? null,
        c.claimedCount ?? null,
        c.processedCount ?? null,
        c.failedCount ?? null,
        params.error ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error(`Запуск ${params.runId} не найден`);
    return mapRun(row);
  }

  async incrementCounters(runId: string, delta: RunCounters): Promise<void> {
    await this.pool.query(
      `UPDATE runs
       SET planned_count   = planned_count   + $2,
           claimed_count   = claimed_count   + $3,
           processed_count = processed_count + $4,
           failed_count    = failed_count    + $5
       WHERE id = $1`,
      [
        runId,
        delta.plannedCount ?? 0,
        delta.claimedCount ?? 0,
        delta.processedCount ?? 0,
        delta.failedCount ?? 0,
      ],
    );
  }

  async findById(runId: string): Promise<Run | null> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE id = $1`,
      [runId],
    );
    const row = rows[0];
    return row ? mapRun(row) : null;
  }

  async findActive(): Promise<Run | null> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE status = 'running' LIMIT 1`,
    );
    const row = rows[0];
    return row ? mapRun(row) : null;
  }

  async listRunning(): Promise<readonly Run[]> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE status = 'running' ORDER BY started_at`,
    );
    return rows.map(mapRun);
  }

  async listRecent(limit: number): Promise<readonly Run[]> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM runs ORDER BY started_at DESC LIMIT $1`,
      [Math.min(limit, 100)],
    );
    return rows.map(mapRun);
  }

  async appendEvent(event: {
    runId: string;
    level: EventLevel;
    stage?: string | null;
    sourceSlug?: string | null;
    message: string;
    payload?: Record<string, unknown> | null;
  }): Promise<RunEvent> {
    const { rows } = await this.pool.query<EventRow>(
      `INSERT INTO run_events (run_id, level, stage, source_slug, message, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING ${EVENT_COLUMNS}`,
      [
        event.runId,
        event.level,
        event.stage ?? null,
        event.sourceSlug ?? null,
        event.message,
        event.payload ? JSON.stringify(event.payload) : null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('Не удалось записать событие');
    return mapEvent(row);
  }

  async listEvents(params: {
    runId: string;
    afterId?: string;
    limit: number;
  }): Promise<readonly RunEvent[]> {
    const limit = Math.min(params.limit, 500);

    if (params.afterId !== undefined) {
      const { rows } = await this.pool.query<EventRow>(
        `SELECT ${EVENT_COLUMNS} FROM run_events
         WHERE run_id = $1 AND id > $2
         ORDER BY id ASC LIMIT $3`,
        [params.runId, params.afterId, limit],
      );
      return rows.map(mapEvent);
    }

    const { rows } = await this.pool.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM run_events
       WHERE run_id = $1
       ORDER BY id ASC LIMIT $2`,
      [params.runId, limit],
    );
    return rows.map(mapEvent);
  }
}
