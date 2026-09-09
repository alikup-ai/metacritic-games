-- =============================================================================
-- 001_initial_schema
-- Базовая схема: каталог игр, план обработки, реестр claim, запуски, события.
-- Соответствует docs/DATA_MODEL.md. Обоснования: ADR-0002, 0003, 0004, 0008.
-- =============================================================================

-- Расширения из стандартного образа postgres:16 (contrib).
-- pgvector намеренно не требуется (ADR-0009) — см. миграцию 003.
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- поиск по названию

-- -----------------------------------------------------------------------------
-- games
-- UUID как внутренний PK, (source, source_slug) как внешний ключ (ADR-0003).
-- Source metadata отделены от доменных полей.
-- -----------------------------------------------------------------------------
CREATE TABLE games (
    id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

    -- source metadata (технические поля источника)
    source             TEXT         NOT NULL DEFAULT 'metacritic',
    source_slug        TEXT         NOT NULL,
    source_url         TEXT,
    parser_version     TEXT         NOT NULL DEFAULT 'v1',

    -- доменные поля
    title              TEXT         NOT NULL,
    description        TEXT,
    cover_url          TEXT,
    trailer_url        TEXT,

    -- developer/publisher хранятся раздельно; подмена запрещена (ADR-0003).
    -- developer NULL допустим: подтверждён реальный случай отсутствия данных.
    developer          TEXT,
    developer_status   TEXT         NOT NULL DEFAULT 'unknown',
    publishers         TEXT[]       NOT NULL DEFAULT '{}',

    genres             TEXT[]       NOT NULL DEFAULT '{}',
    release_date       DATE,

    -- денормализация для сортировки в списке
    metascore_overall  SMALLINT,
    userscore_overall  NUMERIC(3,1),

    content_hash       TEXT,

    first_seen_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT games_source_slug_uniq UNIQUE (source, source_slug),
    CONSTRAINT games_title_not_empty  CHECK (length(btrim(title)) > 0),
    CONSTRAINT games_developer_status_valid
        CHECK (developer_status IN ('resolved', 'unknown')),
    -- Нельзя объявить разработчика определённым, не указав его.
    CONSTRAINT games_developer_consistency
        CHECK (developer_status <> 'resolved' OR developer IS NOT NULL),
    CONSTRAINT games_metascore_range
        CHECK (metascore_overall IS NULL OR metascore_overall BETWEEN 0 AND 100),
    CONSTRAINT games_userscore_range
        CHECK (userscore_overall IS NULL OR userscore_overall BETWEEN 0 AND 10)
);

CREATE INDEX games_metascore_idx    ON games (metascore_overall DESC NULLS LAST);
CREATE INDEX games_userscore_idx    ON games (userscore_overall DESC NULLS LAST);
CREATE INDEX games_release_date_idx ON games (release_date DESC NULLS LAST);
CREATE INDEX games_title_trgm_idx   ON games USING gin (title gin_trgm_ops);
CREATE INDEX games_genres_idx       ON games USING gin (genres);
-- Частичный индекс: мониторинг качества парсинга developer
CREATE INDEX games_developer_unknown_idx ON games (last_updated_at DESC)
    WHERE developer_status = 'unknown';

COMMENT ON COLUMN games.developer_status IS
    'resolved = разработчик определён; unknown = не найден в разметке (ADR-0003)';
COMMENT ON COLUMN games.parser_version IS
    'Версия парсера — позволяет переобработать записи после смены разметки';

-- -----------------------------------------------------------------------------
-- game_platforms
-- Раздельные scope: достоверность привязки к платформе у метрик разная (ADR-0008).
-- -----------------------------------------------------------------------------
CREATE TABLE game_platforms (
    game_id          UUID         NOT NULL
        REFERENCES games (id) ON DELETE CASCADE,
    platform_slug    TEXT         NOT NULL,
    platform_name    TEXT         NOT NULL,

    -- NULL означает 'tbd' — платформа известна, оценки ещё нет
    metascore        SMALLINT,
    metascore_scope  TEXT         NOT NULL DEFAULT 'platform',
    userscore        NUMERIC(3,1),
    userscore_scope  TEXT         NOT NULL DEFAULT 'overall_fallback',

    critic_count     INTEGER,
    user_count       INTEGER,
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),

    PRIMARY KEY (game_id, platform_slug),
    CONSTRAINT game_platforms_metascore_scope_valid
        CHECK (metascore_scope IN ('platform', 'overall_fallback', 'derived')),
    CONSTRAINT game_platforms_userscore_scope_valid
        CHECK (userscore_scope IN ('platform', 'overall_fallback', 'derived')),
    CONSTRAINT game_platforms_metascore_range
        CHECK (metascore IS NULL OR metascore BETWEEN 0 AND 100),
    CONSTRAINT game_platforms_userscore_range
        CHECK (userscore IS NULL OR userscore BETWEEN 0 AND 10),
    CONSTRAINT game_platforms_critic_count_valid
        CHECK (critic_count IS NULL OR critic_count >= 0),
    CONSTRAINT game_platforms_user_count_valid
        CHECK (user_count IS NULL OR user_count >= 0),
    CONSTRAINT game_platforms_slug_not_empty
        CHECK (length(btrim(platform_slug)) > 0)
);

CREATE INDEX game_platforms_platform_idx ON game_platforms (platform_slug);
CREATE INDEX game_platforms_platform_score_idx
    ON game_platforms (platform_slug, metascore DESC NULLS LAST);

COMMENT ON COLUMN game_platforms.metascore_scope IS
    'platform = оценка именно этой платформы (доказано); overall_fallback = общая по игре';
COMMENT ON COLUMN game_platforms.userscore_scope IS
    'Userscore по платформам Metacritic не публикует — по умолчанию overall_fallback';

-- -----------------------------------------------------------------------------
-- processing_days
-- План на календарные сутки; day вычисляется по PROCESSING_TIMEZONE (ADR-0002).
-- -----------------------------------------------------------------------------
CREATE TABLE processing_days (
    day                DATE         PRIMARY KEY,
    phase              TEXT         NOT NULL DEFAULT 'new_releases',
    browse_page        INTEGER      NOT NULL DEFAULT 1,
    new_releases_done  BOOLEAN      NOT NULL DEFAULT FALSE,
    claimed_count      INTEGER      NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT processing_days_phase_valid
        CHECK (phase IN ('new_releases', 'browse', 'exhausted')),
    CONSTRAINT processing_days_browse_page_valid CHECK (browse_page >= 1),
    CONSTRAINT processing_days_claimed_count_valid CHECK (claimed_count >= 0)
);

COMMENT ON COLUMN processing_days.browse_page IS
    'Курсор — ПОДСКАЗКА. Источник истины о обработанном — daily_claims (ADR-0002)';

-- -----------------------------------------------------------------------------
-- runs
-- -----------------------------------------------------------------------------
CREATE TABLE runs (
    id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    trigger          TEXT         NOT NULL,
    status           TEXT         NOT NULL DEFAULT 'running',
    started_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    finished_at      TIMESTAMPTZ,
    planned_count    INTEGER      NOT NULL DEFAULT 0,
    claimed_count    INTEGER      NOT NULL DEFAULT 0,
    processed_count  INTEGER      NOT NULL DEFAULT 0,
    failed_count     INTEGER      NOT NULL DEFAULT 0,
    error            TEXT,

    CONSTRAINT runs_trigger_valid CHECK (trigger IN ('cron', 'manual')),
    -- blocked отделён от failed: блокировка требует иной реакции, чем ошибка
    CONSTRAINT runs_status_valid
        CHECK (status IN ('running', 'completed', 'failed', 'skipped', 'blocked')),
    CONSTRAINT runs_finished_consistency
        CHECK (status = 'running' OR finished_at IS NOT NULL),
    CONSTRAINT runs_counts_valid CHECK (
        planned_count >= 0 AND claimed_count >= 0
        AND processed_count >= 0 AND failed_count >= 0
    )
);

CREATE INDEX runs_started_at_idx ON runs (started_at DESC);
-- Второй барьер против параллельных запусков (в дополнение к advisory lock)
CREATE UNIQUE INDEX runs_single_active_idx ON runs ((status)) WHERE status = 'running';

-- -----------------------------------------------------------------------------
-- daily_claims — ЯДРО ИДЕМПОТЕНТНОСТИ (ADR-0004)
-- PK (processing_day, source, source_slug) делает двойной claim одной игры
-- в одни сутки физически невозможным.
-- -----------------------------------------------------------------------------
CREATE TABLE daily_claims (
    processing_day  DATE         NOT NULL
        REFERENCES processing_days (day) ON DELETE CASCADE,
    source          TEXT         NOT NULL,
    source_slug     TEXT         NOT NULL,

    -- NULL до первого успешного сохранения игры
    game_id         UUID         REFERENCES games (id) ON DELETE SET NULL,
    run_id          UUID         REFERENCES runs (id)  ON DELETE SET NULL,

    status          TEXT         NOT NULL DEFAULT 'claimed',
    claimed_at      TIMESTAMPTZ,
    lease_until     TIMESTAMPTZ,
    attempts        INTEGER      NOT NULL DEFAULT 0,
    stages          JSONB        NOT NULL DEFAULT '{}'::jsonb,
    last_error      TEXT,
    completed_at    TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),

    PRIMARY KEY (processing_day, source, source_slug),

    CONSTRAINT daily_claims_status_valid
        CHECK (status IN ('pending', 'claimed', 'done', 'failed')),
    CONSTRAINT daily_claims_attempts_valid CHECK (attempts >= 0),
    -- Захваченная запись обязана иметь срок аренды, иначе зависнет навсегда
    CONSTRAINT daily_claims_lease_required
        CHECK (status <> 'claimed' OR lease_until IS NOT NULL),
    CONSTRAINT daily_claims_completed_required
        CHECK (status <> 'done' OR completed_at IS NOT NULL),
    CONSTRAINT daily_claims_slug_not_empty
        CHECK (length(btrim(source_slug)) > 0)
);

-- Индекс для reaper: только активные аренды
CREATE INDEX daily_claims_lease_idx ON daily_claims (lease_until)
    WHERE status = 'claimed';
CREATE INDEX daily_claims_day_status_idx ON daily_claims (processing_day, status);
CREATE INDEX daily_claims_run_idx ON daily_claims (run_id);

COMMENT ON TABLE daily_claims IS
    'Реестр "обработано сегодня" + claim/lease. PK гарантирует идемпотентность (ADR-0004)';
COMMENT ON COLUMN daily_claims.stages IS
    'Прогресс по стадиям — позволяет возобновить частично выполненную работу';

-- -----------------------------------------------------------------------------
-- run_events — аудит и источник для SSE
-- BIGSERIAL: монотонный курсор для докачки событий клиентом
-- -----------------------------------------------------------------------------
CREATE TABLE run_events (
    id           BIGSERIAL    PRIMARY KEY,
    run_id       UUID         NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    ts           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    level        TEXT         NOT NULL DEFAULT 'info',
    stage        TEXT,
    source_slug  TEXT,
    message      TEXT         NOT NULL,
    payload      JSONB,

    CONSTRAINT run_events_level_valid
        CHECK (level IN ('debug', 'info', 'warn', 'error'))
);

CREATE INDEX run_events_run_idx ON run_events (run_id, id DESC);
CREATE INDEX run_events_ts_idx  ON run_events (ts DESC);

COMMENT ON TABLE run_events IS
    'Самая быстрорастущая таблица — требует очистки старше 30 дней (retention)';
