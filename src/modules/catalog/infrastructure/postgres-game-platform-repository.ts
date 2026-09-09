import type { DbPool } from '../../../shared/db/pool.js';
import { resolveExecutor } from '../../../shared/db/unit-of-work.js';
import type { ScoreScope } from '../domain/game.js';
import type {
  GamePlatformInput,
  GamePlatformRepository,
  PlatformSyncResult,
  StoredGamePlatform,
} from '../domain/game-repository.js';
import type { TxContext } from '../domain/unit-of-work.js';

interface PlatformRow {
  platform_slug: string;
  platform_name: string;
  metascore: number | null;
  metascore_scope: string;
  userscore: string | null;
  userscore_scope: string;
  critic_count: number | null;
  user_count: number | null;
  is_active: boolean;
  last_seen_at: Date;
  deactivated_at: Date | null;
}

function toNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function mapPlatform(row: PlatformRow): StoredGamePlatform {
  return {
    platformSlug: row.platform_slug,
    platformName: row.platform_name,
    metascore: row.metascore,
    metascoreScope: row.metascore_scope as ScoreScope,
    userscore: toNumber(row.userscore),
    userscoreScope: row.userscore_scope as ScoreScope,
    criticCount: row.critic_count,
    userCount: row.user_count,
    isActive: row.is_active,
    lastSeenAt: row.last_seen_at,
    deactivatedAt: row.deactivated_at,
  };
}

const PLATFORM_COLUMNS = `
  platform_slug, platform_name, metascore, metascore_scope,
  userscore, userscore_scope, critic_count, user_count,
  is_active, last_seen_at, deactivated_at
`;

export class PostgresGamePlatformRepository implements GamePlatformRepository {
  constructor(private readonly pool: DbPool) {}

  /**
   * Приводит набор платформ к снимку источника (ADR-0011).
   *
   * Исчезнувшие платформы ОТКЛЮЧАЮТСЯ, а не удаляются: исчезновение чаще
   * означает сбой парсинга, чем реальное снятие игры с платформы, и
   * удаление уничтожило бы данные незаметно.
   */
  async replacePlatformSnapshot(
    gameId: string,
    platforms: readonly GamePlatformInput[],
    tx?: TxContext,
  ): Promise<PlatformSyncResult> {
    const executor = resolveExecutor(this.pool, tx);

    // Пустой снимок трактуется как ОТСУТСТВИЕ ДАННЫХ, а не как «платформ
    // больше нет». Иначе одна поломка парсера отключила бы платформы у всех
    // обработанных игр за один проход.
    if (platforms.length === 0) {
      return {
        created: 0,
        updated: 0,
        deactivated: 0,
        reactivated: 0,
        skippedDeactivation: true,
      };
    }

    // Состояние до синхронизации нужно, чтобы различить создание,
    // обновление и реактивацию.
    const { rows: existingRows } = await executor.query<{
      platform_slug: string;
      is_active: boolean;
    }>(`SELECT platform_slug, is_active FROM game_platforms WHERE game_id = $1`, [gameId]);

    const existing = new Map(existingRows.map((r) => [r.platform_slug, r.is_active]));

    let created = 0;
    let updated = 0;
    let reactivated = 0;

    for (const platform of platforms) {
      const previous = existing.get(platform.platformSlug);

      await executor.query(
        `INSERT INTO game_platforms (
           game_id, platform_slug, platform_name,
           metascore, metascore_scope, userscore, userscore_scope,
           critic_count, user_count,
           is_active, last_seen_at, deactivated_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, TRUE, now(), NULL, now())
         ON CONFLICT (game_id, platform_slug) DO UPDATE SET
           platform_name   = EXCLUDED.platform_name,
           metascore       = EXCLUDED.metascore,
           metascore_scope = EXCLUDED.metascore_scope,
           userscore       = EXCLUDED.userscore,
           userscore_scope = EXCLUDED.userscore_scope,
           critic_count    = EXCLUDED.critic_count,
           user_count      = EXCLUDED.user_count,
           -- Вернувшаяся платформа снова становится активной
           is_active       = TRUE,
           last_seen_at    = now(),
           deactivated_at  = NULL,
           updated_at      = now()`,
        [
          gameId,
          platform.platformSlug,
          platform.platformName,
          platform.metascore,
          platform.metascoreScope,
          platform.userscore,
          platform.userscoreScope,
          platform.criticCount,
          platform.userCount,
        ],
      );

      if (previous === undefined) created += 1;
      else if (previous === false) reactivated += 1;
      else updated += 1;
    }

    // Отключаем то, чего нет в снимке. Данные сохраняются полностью.
    const presentSlugs = platforms.map((p) => p.platformSlug);
    const { rowCount } = await executor.query(
      `UPDATE game_platforms
       SET is_active      = FALSE,
           deactivated_at = now(),
           updated_at     = now()
       WHERE game_id = $1
         AND is_active
         AND platform_slug <> ALL($2::text[])`,
      [gameId, presentSlugs],
    );

    return {
      created,
      updated,
      deactivated: rowCount ?? 0,
      reactivated,
      skippedDeactivation: false,
    };
  }

  async findActiveByGameId(
    gameId: string,
    tx?: TxContext,
  ): Promise<readonly StoredGamePlatform[]> {
    const executor = resolveExecutor(this.pool, tx);
    const { rows } = await executor.query<PlatformRow>(
      `SELECT ${PLATFORM_COLUMNS} FROM game_platforms
       WHERE game_id = $1 AND is_active
       ORDER BY platform_slug`,
      [gameId],
    );
    return rows.map(mapPlatform);
  }

  async findAllByGameId(
    gameId: string,
    tx?: TxContext,
  ): Promise<readonly StoredGamePlatform[]> {
    const executor = resolveExecutor(this.pool, tx);
    const { rows } = await executor.query<PlatformRow>(
      `SELECT ${PLATFORM_COLUMNS} FROM game_platforms
       WHERE game_id = $1
       ORDER BY platform_slug`,
      [gameId],
    );
    return rows.map(mapPlatform);
  }

  async listDistinctPlatforms(): Promise<readonly { slug: string; name: string }[]> {
    const { rows } = await this.pool.query<{
      platform_slug: string;
      platform_name: string;
    }>(
      `SELECT DISTINCT platform_slug, platform_name
       FROM game_platforms
       WHERE is_active
       ORDER BY platform_name`,
    );
    return rows.map((r) => ({ slug: r.platform_slug, name: r.platform_name }));
  }
}
