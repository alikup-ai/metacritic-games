import { createHash } from 'node:crypto';
import type { DbPool } from '../../../shared/db/pool.js';
import { resolveExecutor } from '../../../shared/db/unit-of-work.js';
import type { TxContext } from '../../catalog/domain/unit-of-work.js';
import {
  reviewKey,
  type NormalizedReview,
  type ReviewKind,
  type ReviewSnapshot,
  type SnapshotCompleteness,
  type StoredReview,
} from '../domain/review.js';
import type {
  ReviewRepository,
  ReviewSnapshotRepository,
} from '../domain/review-ports.js';
import { upsertReviews } from './upsert-reviews.js';

/**
 * Хранение отзывов и метаданных снимков в PostgreSQL (ADR-0012).
 *
 * Идемпотентность обеспечивают ЧАСТИЧНЫЕ уникальные индексы: ключи разных
 * типов лежат в разных колонках, и общий индекс допускал бы NULL-дыры.
 */

interface ReviewRow {
  id: string;
  game_id: string;
  kind: string;
  platform_slug: string;
  external_id: string | null;
  publication_slug: string | null;
  score: number | null;
  quote: string;
  author: string | null;
  review_url: string | null;
  review_date: string | null;
  source_version: string | null;
  spoiler: boolean | null;
  content_hash: string;
  first_seen_at: Date;
  last_seen_at: Date;
}

interface SnapshotRow {
  game_id: string;
  kind: string;
  platform_slug: string;
  fingerprint: string;
  review_count: number;
  total_available: number | null;
  completeness: string;
  malformed_count: number;
  fetched_at: Date;
}

export function hashContent(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function mapReview(row: ReviewRow): StoredReview {
  const identity =
    row.kind === 'user'
      ? ({ kind: 'user', externalId: row.external_id as string } as const)
      : ({ kind: 'critic', publicationSlug: row.publication_slug as string } as const);

  return {
    id: row.id,
    gameId: row.game_id,
    identity,
    platformSlug: row.platform_slug,
    score: row.score,
    quote: row.quote,
    author: row.author,
    reviewUrl: row.review_url,
    reviewDate: row.review_date,
    // BIGINT приходит строкой — приводим явно
    sourceVersion: row.source_version === null ? null : Number(row.source_version),
    spoiler: row.spoiler,
    contentHash: row.content_hash,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

const REVIEW_COLUMNS = `
  id, game_id, kind, platform_slug, external_id, publication_slug,
  score, quote, author, review_url, review_date, source_version, spoiler,
  content_hash, first_seen_at, last_seen_at
`;

export class PostgresReviewRepository implements ReviewRepository {
  constructor(private readonly pool: DbPool) {}

  /**
   * Создаёт или обновляет отзывы по ключу источника.
   *
   * Логика вынесена в upsertReviews: признак изменения нужно вычислять до
   * записи, поскольку RETURNING отражает уже обновлённую строку.
   */
  async upsertMany(params: {
    gameId: string;
    kind: ReviewKind;
    platformSlug: string;
    reviews: readonly NormalizedReview[];
    tx?: TxContext;
  }): Promise<{ created: number; updated: number; unchanged: number }> {
    const executor = resolveExecutor(this.pool, params.tx);

    return upsertReviews(executor, {
      gameId: params.gameId,
      kind: params.kind,
      platformSlug: params.platformSlug,
      reviews: params.reviews,
      hash: hashContent,
    });
  }

  /**
   * Удаляет отзывы, отсутствующие в переданном наборе ключей.
   *
   * Вызывающий обязан убедиться, что снимок полный: при частичном
   * отсутствие отзыва не означает удаления (ADR-0012).
   */
  async deleteMissing(params: {
    gameId: string;
    kind: ReviewKind;
    platformSlug: string;
    presentKeys: readonly string[];
    tx?: TxContext;
  }): Promise<number> {
    const executor = resolveExecutor(this.pool, params.tx);

    // Ключ в БД собирается тем же способом, что и в домене, — иначе
    // сравнение множеств разошлось бы.
    const keyExpression =
      params.kind === 'user'
        ? `'user:' || external_id`
        : `'critic:' || publication_slug`;

    const { rowCount } = await executor.query(
      `DELETE FROM reviews
       WHERE game_id = $1 AND kind = $2 AND platform_slug = $3
         AND ${keyExpression} <> ALL($4::text[])`,
      [params.gameId, params.kind, params.platformSlug, params.presentKeys],
    );

    return rowCount ?? 0;
  }

  async findByGame(params: {
    gameId: string;
    kind: ReviewKind;
    platformSlug: string;
    tx?: TxContext;
  }): Promise<readonly StoredReview[]> {
    const executor = resolveExecutor(this.pool, params.tx);
    const { rows } = await executor.query<ReviewRow>(
      `SELECT ${REVIEW_COLUMNS} FROM reviews
       WHERE game_id = $1 AND kind = $2 AND platform_slug = $3
       ORDER BY review_date DESC NULLS LAST, id`,
      [params.gameId, params.kind, params.platformSlug],
    );
    return rows.map(mapReview);
  }

  async listPaged(params: {
    gameId: string;
    kind: ReviewKind;
    platformSlug?: string;
    limit: number;
    offset: number;
  }): Promise<{ items: readonly StoredReview[]; total: number }> {
    const conditions = ['game_id = $1', 'kind = $2'];
    const values: unknown[] = [params.gameId, params.kind];

    if (params.platformSlug !== undefined) {
      values.push(params.platformSlug);
      conditions.push(`platform_slug = $${values.length}`);
    }

    const where = conditions.join(' AND ');

    const countResult = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM reviews WHERE ${where}`,
      values,
    );

    values.push(params.limit, params.offset);
    const { rows } = await this.pool.query<ReviewRow>(
      // id в сортировке даёт устойчивый порядок между страницами:
      // без него отзывы с одинаковой датой могли бы повторяться.
      `SELECT ${REVIEW_COLUMNS} FROM reviews
       WHERE ${where}
       ORDER BY review_date DESC NULLS LAST, id
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );

    return {
      items: rows.map(mapReview),
      total: Number(countResult.rows[0]?.count ?? 0),
    };
  }

  async countByGame(params: {
    gameId: string;
    kind: ReviewKind;
    platformSlug: string;
    tx?: TxContext;
  }): Promise<number> {
    const executor = resolveExecutor(this.pool, params.tx);
    const { rows } = await executor.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM reviews
       WHERE game_id = $1 AND kind = $2 AND platform_slug = $3`,
      [params.gameId, params.kind, params.platformSlug],
    );
    return Number(rows[0]?.count ?? 0);
  }
}

export class PostgresReviewSnapshotRepository implements ReviewSnapshotRepository {
  constructor(private readonly pool: DbPool) {}

  async find(params: {
    gameId: string;
    kind: ReviewKind;
    platformSlug: string;
    tx?: TxContext;
  }): Promise<ReviewSnapshot | null> {
    const executor = resolveExecutor(this.pool, params.tx);
    const { rows } = await executor.query<SnapshotRow>(
      `SELECT game_id, kind, platform_slug, fingerprint, review_count,
              total_available, completeness, malformed_count, fetched_at
       FROM review_snapshots
       WHERE game_id = $1 AND kind = $2 AND platform_slug = $3`,
      [params.gameId, params.kind, params.platformSlug],
    );

    const row = rows[0];
    if (!row) return null;

    return {
      gameId: row.game_id,
      kind: row.kind as ReviewKind,
      platformSlug: row.platform_slug,
      fingerprint: row.fingerprint,
      reviewCount: row.review_count,
      totalAvailable: row.total_available,
      completeness: row.completeness as SnapshotCompleteness,
      malformedCount: row.malformed_count,
      fetchedAt: row.fetched_at,
    };
  }

  async save(snapshot: ReviewSnapshot, tx?: TxContext): Promise<void> {
    const executor = resolveExecutor(this.pool, tx);

    await executor.query(
      `INSERT INTO review_snapshots (
         game_id, kind, platform_slug, fingerprint, review_count,
         total_available, completeness, malformed_count, fetched_at, reviews
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NULL)
       ON CONFLICT (game_id, kind, platform_slug) DO UPDATE SET
         fingerprint     = EXCLUDED.fingerprint,
         review_count    = EXCLUDED.review_count,
         total_available = EXCLUDED.total_available,
         completeness    = EXCLUDED.completeness,
         malformed_count = EXCLUDED.malformed_count,
         fetched_at      = EXCLUDED.fetched_at`,
      [
        snapshot.gameId,
        snapshot.kind,
        snapshot.platformSlug,
        snapshot.fingerprint,
        snapshot.reviewCount,
        snapshot.totalAvailable,
        snapshot.completeness,
        snapshot.malformedCount,
        snapshot.fetchedAt,
      ],
    );
  }
}

/** Ключ отзыва — реэкспорт для использования в composition root. */
export { reviewKey };
