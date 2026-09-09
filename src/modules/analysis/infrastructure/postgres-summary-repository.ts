import type { DbPool } from '../../../shared/db/pool.js';
import { resolveExecutor } from '../../../shared/db/unit-of-work.js';
import type { TxContext } from '../../catalog/domain/unit-of-work.js';
import type { ReviewKind, SnapshotCompleteness } from '../../reviews/domain/review.js';
import type {
  AnalysisConfidence,
  AnalysisPoint,
  AnalysisTheme,
} from '../domain/llm-provider.js';
import type {
  ReviewCoverage,
  ReviewSummary,
  ReviewSummaryRepository,
  SummaryStatus,
} from '../domain/summary.js';

/**
 * Хранение резюме в PostgreSQL.
 *
 * Записываются ТОЛЬКО поля резюме. Вывод модели остаётся недоверенным и не
 * может затронуть игры, отзывы или что-либо ещё: список колонок фиксирован
 * в запросе, произвольных полей туда не попадает.
 */

interface SummaryRow {
  game_id: string;
  kind: string;
  platform_slug: string;
  status: string;
  verdict: string | null;
  likes: string | null;
  dislikes: string | null;
  liked_items: AnalysisPoint[] | null;
  disliked_items: AnalysisPoint[] | null;
  themes: AnalysisTheme[] | null;
  confidence: string | null;
  input_hash: string | null;
  source_fingerprint: string;
  model: string;
  prompt_version: string;
  sampling_version: string | null;
  analyzed_count: number;
  total_available: number | null;
  snapshot_completeness: string | null;
  coverage: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  last_error: string | null;
  error_category: string | null;
  generated_at: Date;
}

const SUMMARY_COLUMNS = `
  game_id, kind, platform_slug, status, verdict, likes, dislikes,
  liked_items, disliked_items, themes, confidence, input_hash,
  source_fingerprint, model, prompt_version, sampling_version,
  analyzed_count, total_available, snapshot_completeness, coverage,
  tokens_in, tokens_out, last_error, error_category, generated_at
`;

/** Текстовое представление для отображения; структура живёт в JSONB. */
function toDisplayText(points: readonly AnalysisPoint[]): string | null {
  if (points.length === 0) return null;
  return points.map((point) => point.text).join('; ');
}

function mapSummary(row: SummaryRow): ReviewSummary {
  return {
    gameId: row.game_id,
    kind: row.kind as ReviewKind,
    platformSlug: row.platform_slug,
    status: row.status as SummaryStatus,
    summary: row.verdict,
    liked: row.liked_items ?? [],
    disliked: row.disliked_items ?? [],
    themes: row.themes ?? [],
    confidence: row.confidence as AnalysisConfidence | null,
    inputHash: row.input_hash,
    sourceFingerprint: row.source_fingerprint,
    model: row.model,
    promptVersion: row.prompt_version,
    samplingVersion: row.sampling_version,
    analyzedCount: row.analyzed_count,
    totalAvailable: row.total_available,
    snapshotCompleteness: row.snapshot_completeness as SnapshotCompleteness | null,
    coverage: row.coverage as ReviewCoverage | null,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    lastError: row.last_error,
    errorCategory: row.error_category,
    generatedAt: row.generated_at,
  };
}

export class PostgresReviewSummaryRepository implements ReviewSummaryRepository {
  constructor(private readonly pool: DbPool) {}

  async find(params: {
    gameId: string;
    kind: ReviewKind;
    platformSlug: string;
    tx?: TxContext;
  }): Promise<ReviewSummary | null> {
    const executor = resolveExecutor(this.pool, params.tx);
    const { rows } = await executor.query<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM review_summaries
       WHERE game_id = $1 AND kind = $2 AND platform_slug = $3`,
      [params.gameId, params.kind, params.platformSlug],
    );

    const row = rows[0];
    return row ? mapSummary(row) : null;
  }

  async findByGame(gameId: string, tx?: TxContext): Promise<readonly ReviewSummary[]> {
    const executor = resolveExecutor(this.pool, tx);
    const { rows } = await executor.query<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM review_summaries
       WHERE game_id = $1
       ORDER BY kind, platform_slug`,
      [gameId],
    );
    return rows.map(mapSummary);
  }

  /**
   * Сохраняет резюме, заменяя предыдущее для той же тройки.
   *
   * Уникальный ключ (game_id, kind, platform_slug) разрешает гонку: при
   * одновременном анализе одного входа двумя процессами второй обновит
   * строку, а не создаст дубликат.
   */
  async save(summary: ReviewSummary, tx?: TxContext): Promise<void> {
    const executor = resolveExecutor(this.pool, tx);

    await executor.query(
      `INSERT INTO review_summaries (
         game_id, kind, platform_slug, status,
         verdict, likes, dislikes,
         liked_items, disliked_items, themes, confidence,
         input_hash, source_fingerprint, model, prompt_version, sampling_version,
         analyzed_count, total_available, snapshot_completeness, coverage,
         tokens_in, tokens_out, last_error, error_category, generated_at
       )
       VALUES (
         $1,$2,$3,$4,$5,$6,$7,
         $8::jsonb,$9::jsonb,$10::jsonb,$11,
         $12,$13,$14,$15,$16,
         $17,$18,$19,$20,$21,$22,$23,$24,$25
       )
       ON CONFLICT (game_id, kind, platform_slug) DO UPDATE SET
         status                = EXCLUDED.status,
         verdict               = EXCLUDED.verdict,
         likes                 = EXCLUDED.likes,
         dislikes              = EXCLUDED.dislikes,
         liked_items           = EXCLUDED.liked_items,
         disliked_items        = EXCLUDED.disliked_items,
         themes                = EXCLUDED.themes,
         confidence            = EXCLUDED.confidence,
         input_hash            = EXCLUDED.input_hash,
         source_fingerprint    = EXCLUDED.source_fingerprint,
         model                 = EXCLUDED.model,
         prompt_version        = EXCLUDED.prompt_version,
         sampling_version      = EXCLUDED.sampling_version,
         analyzed_count        = EXCLUDED.analyzed_count,
         total_available       = EXCLUDED.total_available,
         snapshot_completeness = EXCLUDED.snapshot_completeness,
         coverage              = EXCLUDED.coverage,
         tokens_in             = EXCLUDED.tokens_in,
         tokens_out            = EXCLUDED.tokens_out,
         last_error            = EXCLUDED.last_error,
         error_category        = EXCLUDED.error_category,
         generated_at          = EXCLUDED.generated_at`,
      [
        summary.gameId,
        summary.kind,
        summary.platformSlug,
        summary.status,
        summary.summary,
        toDisplayText(summary.liked),
        toDisplayText(summary.disliked),
        JSON.stringify(summary.liked),
        JSON.stringify(summary.disliked),
        JSON.stringify(summary.themes),
        summary.confidence,
        summary.inputHash,
        summary.sourceFingerprint,
        summary.model,
        summary.promptVersion,
        summary.samplingVersion,
        summary.analyzedCount,
        summary.totalAvailable,
        summary.snapshotCompleteness,
        summary.coverage,
        summary.tokensIn,
        summary.tokensOut,
        summary.lastError,
        summary.errorCategory,
        summary.generatedAt,
      ],
    );
  }
}
