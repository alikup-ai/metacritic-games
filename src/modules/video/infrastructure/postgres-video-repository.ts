import type { DbPool } from '../../../shared/db/pool.js';
import type {
  TranscriptSource,
  VideoInsight,
  VideoInsightStatus,
  VideoPoint,
} from '../domain/video.js';
import type { VideoInsightRepository } from '../domain/video-ports.js';

/**
 * Хранение обогащения видео в PostgreSQL.
 *
 * Текст расшифровки НЕ хранится: для работы достаточно отпечатка,
 * сведений о ролике и результата разбора.
 */

interface InsightRow {
  game_id: string;
  status: string;
  video_id: string | null;
  video_url: string | null;
  video_title: string | null;
  channel_title: string | null;
  view_count: string | number | null;
  published_at: Date | null;
  duration_seconds: number | null;
  transcript_source: string;
  transcript_hash: string | null;
  summary: string | null;
  liked_items: VideoPoint[] | null;
  disliked_items: VideoPoint[] | null;
  themes: string[] | null;
  conclusion: string | null;
  model: string | null;
  prompt_version: string | null;
  last_error: string | null;
  generated_at: Date | null;
}

const COLUMNS = `
  game_id, status, video_id, video_url, video_title, channel_title,
  view_count, published_at, duration_seconds, transcript_source,
  transcript_hash, summary, liked_items, disliked_items, themes,
  conclusion, model, prompt_version, last_error, generated_at
`;

function mapRow(row: InsightRow): VideoInsight {
  return {
    gameId: row.game_id,
    status: row.status as VideoInsightStatus,
    videoId: row.video_id,
    videoUrl: row.video_url,
    videoTitle: row.video_title,
    channelTitle: row.channel_title,
    // bigint приходит строкой — приводим к числу
    viewCount: row.view_count === null ? null : Number(row.view_count),
    publishedAt: row.published_at ? row.published_at.toISOString() : null,
    durationSeconds: row.duration_seconds,
    transcriptSource: row.transcript_source as TranscriptSource,
    transcriptHash: row.transcript_hash,
    summary: row.summary,
    liked: row.liked_items ?? [],
    disliked: row.disliked_items ?? [],
    themes: row.themes ?? [],
    conclusion: row.conclusion,
    model: row.model,
    promptVersion: row.prompt_version,
    lastError: row.last_error,
    generatedAt: row.generated_at ?? new Date(0),
  };
}

export class PostgresVideoInsightRepository implements VideoInsightRepository {
  constructor(private readonly pool: DbPool) {}

  async find(gameId: string): Promise<VideoInsight | null> {
    const { rows } = await this.pool.query<InsightRow>(
      `SELECT ${COLUMNS} FROM video_insights WHERE game_id = $1`,
      [gameId],
    );
    const row = rows[0];
    return row ? mapRow(row) : null;
  }

  /**
   * Сохраняет обогащение, заменяя предыдущее.
   *
   * Уникальный ключ по game_id разрешает гонку: при одновременной
   * обработке одной игры второй процесс обновит строку, а не создаст
   * дубликат.
   */
  async save(insight: VideoInsight): Promise<void> {
    await this.pool.query(
      `INSERT INTO video_insights (
         game_id, status, video_id, video_url, video_title, channel_title,
         view_count, published_at, duration_seconds, transcript_source,
         transcript_hash, summary, liked_items, disliked_items, themes,
         conclusion, model, prompt_version, last_error, generated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
               $13::jsonb,$14::jsonb,$15::jsonb,$16,$17,$18,$19,$20)
       ON CONFLICT (game_id) DO UPDATE SET
         status            = EXCLUDED.status,
         video_id          = EXCLUDED.video_id,
         video_url         = EXCLUDED.video_url,
         video_title       = EXCLUDED.video_title,
         channel_title     = EXCLUDED.channel_title,
         view_count        = EXCLUDED.view_count,
         published_at      = EXCLUDED.published_at,
         duration_seconds  = EXCLUDED.duration_seconds,
         transcript_source = EXCLUDED.transcript_source,
         transcript_hash   = EXCLUDED.transcript_hash,
         summary           = EXCLUDED.summary,
         liked_items       = EXCLUDED.liked_items,
         disliked_items    = EXCLUDED.disliked_items,
         themes            = EXCLUDED.themes,
         conclusion        = EXCLUDED.conclusion,
         model             = EXCLUDED.model,
         prompt_version    = EXCLUDED.prompt_version,
         last_error        = EXCLUDED.last_error,
         generated_at      = EXCLUDED.generated_at`,
      [
        insight.gameId,
        insight.status,
        insight.videoId,
        insight.videoUrl,
        insight.videoTitle,
        insight.channelTitle,
        insight.viewCount,
        insight.publishedAt,
        insight.durationSeconds,
        insight.transcriptSource,
        insight.transcriptHash,
        insight.summary,
        JSON.stringify(insight.liked),
        JSON.stringify(insight.disliked),
        JSON.stringify(insight.themes),
        insight.conclusion,
        insight.model,
        insight.promptVersion,
        insight.lastError,
        insight.generatedAt,
      ],
    );
  }
}
