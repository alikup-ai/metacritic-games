import type { DbClient, DbPool } from '../../../shared/db/pool.js';
import {
  reviewContentParts,
  type NormalizedReview,
  type ReviewKind,
} from '../domain/review.js';

/**
 * Запись набора отзывов с различением создания, обновления и отсутствия
 * изменений.
 *
 * Почему признак изменения вычисляется ДО записи: в `RETURNING` ссылка на
 * таблицу отражает уже обновлённую строку, поэтому сравнить прежний хеш с
 * новым внутри одного `INSERT ... ON CONFLICT` нельзя — сравнение всегда
 * давало бы «не изменилось». Поэтому существующие хеши читаются заранее
 * одним запросом.
 *
 * Чтение и запись выполняются в одной транзакции (её открывает вызывающий),
 * поэтому промежуточное состояние другим процессам не видно.
 */

export interface UpsertReviewsParams {
  readonly gameId: string;
  readonly kind: ReviewKind;
  readonly platformSlug: string;
  readonly reviews: readonly NormalizedReview[];
  readonly hash: (input: string) => string;
}

export interface UpsertReviewsCounters {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
}

/** Ключ отзыва в терминах колонок БД. */
function identityColumns(review: NormalizedReview): {
  externalId: string | null;
  publicationSlug: string | null;
  key: string;
} {
  return review.identity.kind === 'user'
    ? {
        externalId: review.identity.externalId,
        publicationSlug: null,
        key: review.identity.externalId,
      }
    : {
        externalId: null,
        publicationSlug: review.identity.publicationSlug,
        key: review.identity.publicationSlug,
      };
}

export async function upsertReviews(
  executor: DbPool | DbClient,
  params: UpsertReviewsParams,
): Promise<UpsertReviewsCounters> {
  if (params.reviews.length === 0) {
    return { created: 0, updated: 0, unchanged: 0 };
  }

  const keyColumn = params.kind === 'user' ? 'external_id' : 'publication_slug';

  // Шаг 1: снимок текущих хешей. Позволяет различить создание, обновление
  // и отсутствие изменений — без этого все три случая неотличимы.
  const { rows: existingRows } = await executor.query<{
    key: string;
    content_hash: string;
  }>(
    `SELECT ${keyColumn} AS key, content_hash
     FROM reviews
     WHERE game_id = $1 AND kind = $2 AND platform_slug = $3`,
    [params.gameId, params.kind, params.platformSlug],
  );

  const existing = new Map(existingRows.map((row) => [row.key, row.content_hash]));

  const conflictTarget =
    params.kind === 'user'
      ? "(game_id, platform_slug, external_id) WHERE kind = 'user'"
      : "(game_id, platform_slug, publication_slug) WHERE kind = 'critic'";

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const review of params.reviews) {
    const contentHash = params.hash(reviewContentParts(review));
    const identity = identityColumns(review);
    const previousHash = existing.get(identity.key);

    await executor.query(
      `INSERT INTO reviews (
         game_id, kind, platform_slug, external_id, publication_slug,
         score, quote, author, review_url, review_date, source_version,
         spoiler, content_hash
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT ${conflictTarget} DO UPDATE SET
         score          = EXCLUDED.score,
         quote          = EXCLUDED.quote,
         author         = EXCLUDED.author,
         review_url     = EXCLUDED.review_url,
         review_date    = EXCLUDED.review_date,
         source_version = EXCLUDED.source_version,
         spoiler        = EXCLUDED.spoiler,
         content_hash   = EXCLUDED.content_hash,
         last_seen_at   = now()`,
      [
        params.gameId,
        params.kind,
        params.platformSlug,
        identity.externalId,
        identity.publicationSlug,
        review.score,
        review.quote,
        review.author,
        review.reviewUrl,
        review.reviewDate,
        review.sourceVersion,
        review.spoiler,
        contentHash,
      ],
    );

    if (previousHash === undefined) created += 1;
    else if (previousHash !== contentHash) updated += 1;
    else unchanged += 1;
  }

  return { created, updated, unchanged };
}
