import type { DbPool } from '../../../shared/db/pool.js';
import { resolveExecutor } from '../../../shared/db/unit-of-work.js';
import {
  assertDeveloperConsistency,
  type DeveloperStatus,
  type Game,
  type GameSource,
  type GameUpsertInput,
} from '../domain/game.js';
import type {
  GameListQuery,
  GameListResult,
  GameRepository,
  GameUpsertResult,
  SimilarityCandidateRow,
} from '../domain/game-repository.js';
import type { TxContext } from '../domain/unit-of-work.js';

interface GameRow {
  id: string;
  source: string;
  source_slug: string;
  source_url: string | null;
  parser_version: string;
  title: string;
  description: string | null;
  cover_url: string | null;
  trailer_url: string | null;
  developer: string | null;
  developer_status: string;
  publishers: string[];
  genres: string[];
  release_date: string | null;
  metascore_overall: number | null;
  userscore_overall: string | null;
  content_hash: string | null;
  first_seen_at: Date;
  last_updated_at: Date;
}

/** NUMERIC приходит строкой (см. pool.ts) — приводим явно, сохраняя null. */
function toNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function mapGame(row: GameRow): Game {
  return {
    id: row.id,
    source: row.source as GameSource,
    sourceSlug: row.source_slug,
    sourceUrl: row.source_url,
    parserVersion: row.parser_version,
    title: row.title,
    description: row.description,
    coverUrl: row.cover_url,
    trailerUrl: row.trailer_url,
    developer: row.developer,
    developerStatus: row.developer_status as DeveloperStatus,
    publishers: row.publishers,
    genres: row.genres,
    releaseDate: row.release_date,
    metascoreOverall: row.metascore_overall,
    userscoreOverall: toNumber(row.userscore_overall),
    contentHash: row.content_hash,
    firstSeenAt: row.first_seen_at,
    lastUpdatedAt: row.last_updated_at,
  };
}

const GAME_FIELDS = [
  'id',
  'source',
  'source_slug',
  'source_url',
  'parser_version',
  'title',
  'description',
  'cover_url',
  'trailer_url',
  'developer',
  'developer_status',
  'publishers',
  'genres',
  'release_date',
  'metascore_overall',
  'userscore_overall',
  'content_hash',
  'first_seen_at',
  'last_updated_at',
] as const;

const GAME_COLUMNS = GAME_FIELDS.join(', ');
/** Те же колонки с префиксом алиаса — для запросов с JOIN/EXISTS. */
const GAME_COLUMNS_ALIASED = GAME_FIELDS.map((f) => `g.${f}`).join(', ');

interface SimilarityRow {
  id: string;
  title: string;
  cover_url: string | null;
  release_date: string | null;
  developer: string | null;
  publishers: string[] | null;
  genres: string[] | null;
  metascore_overall: number | null;
  userscore_overall: string | number | null;
  platforms: string[] | null;
}

/**
 * Колонки для подбора похожих игр.
 *
 * Платформы собираются подзапросом: иначе на каждую игру потребовался бы
 * отдельный запрос. Учитываются только активные (ADR-0011).
 */
const SIMILARITY_COLUMNS = `
  g.id, g.title, g.cover_url, g.release_date, g.developer,
  g.publishers, g.genres, g.metascore_overall, g.userscore_overall,
  COALESCE(
    (SELECT array_agg(gp.platform_slug ORDER BY gp.platform_slug)
     FROM game_platforms gp
     WHERE gp.game_id = g.id AND gp.is_active),
    ARRAY[]::text[]
  ) AS platforms
`;

function mapSimilarityRow(row: SimilarityRow): SimilarityCandidateRow {
  return {
    id: row.id,
    title: row.title,
    coverUrl: row.cover_url,
    // Дата приходит из PostgreSQL как строка YYYY-MM-DD
    releaseDate: row.release_date === null ? null : String(row.release_date).slice(0, 10),
    developer: row.developer,
    publishers: row.publishers ?? [],
    genres: row.genres ?? [],
    metascore: row.metascore_overall,
    // numeric приходит строкой — приводим к числу
    userscore: row.userscore_overall === null ? null : Number(row.userscore_overall),
    platforms: row.platforms ?? [],
  };
}

export class PostgresGameRepository implements GameRepository {
  constructor(private readonly pool: DbPool) {}

  /**
   * Идемпотентный upsert по (source, source_slug).
   *
   * Признак создания вычисляется через `xmax = 0`: в PostgreSQL это надёжно
   * отличает вставленную строку от обновлённой в рамках ON CONFLICT.
   * Сравнение временных меток для этого не годится — они могут совпасть.
   */
  async upsert(input: GameUpsertInput, tx?: TxContext): Promise<GameUpsertResult> {
    // Инвариант проверяется до обращения к БД, чтобы ошибка была понятной.
    assertDeveloperConsistency(input);

    const executor = resolveExecutor(this.pool, tx);

    // first_seen_at намеренно не входит в DO UPDATE: дата первого появления
    // должна пережить любое число повторных обходов.
    //
    // userscore_overall обновляется через COALESCE: неудача необязательного
    // запроса Userscore не должна затирать ранее полученное значение
    // (ADR-0011, политика согласованности).
    const { rows } = await executor.query<GameRow & { was_inserted: boolean }>(
      `
      INSERT INTO games (
        source, source_slug, source_url, parser_version,
        title, description, cover_url, trailer_url,
        developer, developer_status, publishers, genres, release_date,
        metascore_overall, userscore_overall, content_hash
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (source, source_slug) DO UPDATE SET
        source_url        = EXCLUDED.source_url,
        parser_version    = EXCLUDED.parser_version,
        title             = EXCLUDED.title,
        description       = EXCLUDED.description,
        cover_url         = EXCLUDED.cover_url,
        trailer_url       = EXCLUDED.trailer_url,
        developer         = EXCLUDED.developer,
        developer_status  = EXCLUDED.developer_status,
        publishers        = EXCLUDED.publishers,
        genres            = EXCLUDED.genres,
        release_date      = EXCLUDED.release_date,
        metascore_overall = EXCLUDED.metascore_overall,
        userscore_overall = COALESCE(EXCLUDED.userscore_overall, games.userscore_overall),
        content_hash      = EXCLUDED.content_hash,
        last_updated_at   = now()
      RETURNING ${GAME_COLUMNS}, (xmax = 0) AS was_inserted
      `,
      [
        input.source,
        input.sourceSlug,
        input.sourceUrl ?? null,
        input.parserVersion,
        input.title,
        input.description ?? null,
        input.coverUrl ?? null,
        input.trailerUrl ?? null,
        input.developer ?? null,
        input.developerStatus,
        input.publishers ?? [],
        input.genres ?? [],
        input.releaseDate ?? null,
        input.metascoreOverall ?? null,
        input.userscoreOverall ?? null,
        input.contentHash ?? null,
      ],
    );

    const row = rows[0];
    if (!row) throw new Error('upsert не вернул строку');

    return { game: mapGame(row), created: row.was_inserted };
  }

  async findById(id: string, tx?: TxContext): Promise<Game | null> {
    const executor = resolveExecutor(this.pool, tx);
    const { rows } = await executor.query<GameRow>(
      `SELECT ${GAME_COLUMNS} FROM games WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? mapGame(row) : null;
  }

  async findBySourceSlug(
    source: string,
    sourceSlug: string,
    tx?: TxContext,
  ): Promise<Game | null> {
    const executor = resolveExecutor(this.pool, tx);
    const { rows } = await executor.query<GameRow>(
      `SELECT ${GAME_COLUMNS} FROM games WHERE source = $1 AND source_slug = $2`,
      [source, sourceSlug],
    );
    const row = rows[0];
    return row ? mapGame(row) : null;
  }

  async findForSimilarity(gameId: string): Promise<SimilarityCandidateRow | null> {
    const { rows } = await this.pool.query<SimilarityRow>(
      `SELECT ${SIMILARITY_COLUMNS} FROM games g WHERE g.id = $1`,
      [gameId],
    );
    const row = rows[0];
    return row ? mapSimilarityRow(row) : null;
  }

  async listForSimilarity(params: {
    excludeGameId: string;
    limit: number;
  }): Promise<readonly SimilarityCandidateRow[]> {
    // Платформы собираются подзапросом: без него на каждую игру
    // потребовался бы отдельный запрос.
    // Учитываются только активные платформы (ADR-0011).
    const { rows } = await this.pool.query<SimilarityRow>(
      `SELECT ${SIMILARITY_COLUMNS}
       FROM games g
       WHERE g.id <> $1
       ORDER BY g.id
       LIMIT $2`,
      [params.excludeGameId, params.limit],
    );

    return rows.map(mapSimilarityRow);
  }

  async list(query: GameListQuery): Promise<GameListResult> {
    const limit = Math.min(query.limit ?? 24, 100);
    const offset = Math.max(query.offset ?? 0, 0);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.search && query.search.trim().length > 0) {
      params.push(`%${query.search.trim()}%`);
      conditions.push(`g.title ILIKE $${params.length}`);
    }

    if (query.platformSlugs && query.platformSlugs.length > 0) {
      params.push(query.platformSlugs);
      // Учитываются только активные платформы: отключённые не должны
      // влиять на фильтрацию (ADR-0011).
      conditions.push(`EXISTS (
        SELECT 1 FROM game_platforms gp
        WHERE gp.game_id = g.id
          AND gp.is_active
          AND gp.platform_slug = ANY($${params.length}::text[])
      )`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Поле сортировки выбирается из фиксированного словаря — значение
    // пользователя никогда не попадает в SQL-текст.
    const sortColumns: Record<string, string> = {
      metascore: 'g.metascore_overall',
      userscore: 'g.userscore_overall',
      releaseDate: 'g.release_date',
      title: 'g.title',
    };
    const sortColumn = sortColumns[query.sortBy ?? 'metascore'] ?? 'g.metascore_overall';
    const direction = query.sortDirection === 'asc' ? 'ASC' : 'DESC';
    const nulls = direction === 'ASC' ? 'NULLS FIRST' : 'NULLS LAST';

    const countResult = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM games g ${where}`,
      params,
    );

    params.push(limit, offset);
    const { rows } = await this.pool.query<GameRow>(
      `SELECT ${GAME_COLUMNS_ALIASED}
       FROM games g
       ${where}
       ORDER BY ${sortColumn} ${direction} ${nulls}, g.id
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      items: rows.map(mapGame),
      total: Number(countResult.rows[0]?.count ?? 0),
    };
  }
}
