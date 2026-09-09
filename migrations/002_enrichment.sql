-- =============================================================================
-- 002_enrichment
-- Обогащающие данные: отзывы, LLM-резюме, похожие игры, YouTube.
-- Сырые данные (review_snapshots) отделены от производных (review_summaries).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- review_snapshots — СЫРЫЕ отзывы
-- -----------------------------------------------------------------------------
CREATE TABLE review_snapshots (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id       UUID         NOT NULL REFERENCES games (id) ON DELETE CASCADE,
    kind          TEXT         NOT NULL,
    reviews       JSONB        NOT NULL DEFAULT '[]'::jsonb,
    fingerprint   TEXT         NOT NULL,
    review_count  INTEGER      NOT NULL DEFAULT 0,
    -- Набор мог быть усечён лимитом: резюме тогда построено по части отзывов
    truncated     BOOLEAN      NOT NULL DEFAULT FALSE,
    fetched_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT review_snapshots_kind_valid CHECK (kind IN ('critic', 'user')),
    CONSTRAINT review_snapshots_count_valid CHECK (review_count >= 0),
    CONSTRAINT review_snapshots_game_kind_uniq UNIQUE (game_id, kind)
);

CREATE INDEX review_snapshots_game_idx ON review_snapshots (game_id);

COMMENT ON COLUMN review_snapshots.fingerprint IS
    'Хеш набора отзывов — вход для fingerprint-gate, экономящего вызовы LLM';

-- -----------------------------------------------------------------------------
-- review_summaries — ПРОИЗВОДНЫЕ LLM-резюме
-- Отдельно от сырых отзывов; фиксируются model и prompt_version (ADR-0006)
-- -----------------------------------------------------------------------------
CREATE TABLE review_summaries (
    id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id              UUID         NOT NULL REFERENCES games (id) ON DELETE CASCADE,
    kind                 TEXT         NOT NULL,

    likes                TEXT,
    dislikes             TEXT,
    verdict              TEXT,

    -- insufficient_reviews отличает "отзывов не было" от "генерация не удалась"
    status               TEXT         NOT NULL DEFAULT 'ok',

    source_fingerprint   TEXT         NOT NULL,
    source_review_count  INTEGER      NOT NULL DEFAULT 0,
    model                TEXT         NOT NULL,
    prompt_version       TEXT         NOT NULL,
    tokens_in            INTEGER,
    tokens_out           INTEGER,
    generated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT review_summaries_kind_valid CHECK (kind IN ('critic', 'user')),
    CONSTRAINT review_summaries_status_valid
        CHECK (status IN ('ok', 'insufficient_reviews', 'failed')),
    CONSTRAINT review_summaries_count_valid CHECK (source_review_count >= 0),
    -- Успешное резюме обязано содержать хоть какое-то полезное содержимое
    CONSTRAINT review_summaries_content_required CHECK (
        status <> 'ok' OR likes IS NOT NULL OR dislikes IS NOT NULL OR verdict IS NOT NULL
    ),
    CONSTRAINT review_summaries_game_kind_uniq UNIQUE (game_id, kind)
);

CREATE INDEX review_summaries_game_idx ON review_summaries (game_id);

COMMENT ON COLUMN review_summaries.model IS
    'Фактически использованная модель — без неё нельзя понять, чем сгенерирована запись';

-- -----------------------------------------------------------------------------
-- similar_games — метод фиксируется в строке (ADR-0009)
-- -----------------------------------------------------------------------------
CREATE TABLE similar_games (
    game_id          UUID         NOT NULL REFERENCES games (id) ON DELETE CASCADE,
    similar_game_id  UUID         NOT NULL REFERENCES games (id) ON DELETE CASCADE,
    score            REAL         NOT NULL,
    method           TEXT         NOT NULL DEFAULT 'content_v1',
    factors          JSONB,
    computed_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),

    PRIMARY KEY (game_id, similar_game_id),
    -- Игра не может быть похожа на саму себя
    CONSTRAINT similar_games_no_self CHECK (game_id <> similar_game_id),
    CONSTRAINT similar_games_score_range CHECK (score >= 0 AND score <= 1),
    CONSTRAINT similar_games_method_valid
        CHECK (method IN ('content_v1', 'embedding_v1'))
);

CREATE INDEX similar_games_lookup_idx ON similar_games (game_id, score DESC);

COMMENT ON COLUMN similar_games.factors IS
    'Вклад отдельных факторов — объяснимость подбора для UI и отладки';

-- -----------------------------------------------------------------------------
-- video_insights — YouTube (ADR-0005)
-- -----------------------------------------------------------------------------
CREATE TABLE video_insights (
    id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id            UUID         NOT NULL REFERENCES games (id) ON DELETE CASCADE,

    video_id           TEXT,
    video_url          TEXT,
    video_title        TEXT,
    channel_title      TEXT,
    view_count         BIGINT,

    -- Источник текста обязателен и показывается в UI: сервис не должен
    -- подразумевать расшифровку речи, если её не было
    transcript_source  TEXT         NOT NULL DEFAULT 'none',
    conclusion         TEXT,
    model              TEXT,
    prompt_version     TEXT,

    status             TEXT         NOT NULL DEFAULT 'skipped',
    last_error         TEXT,
    generated_at       TIMESTAMPTZ,

    CONSTRAINT video_insights_transcript_source_valid
        CHECK (transcript_source IN ('official', 'auto', 'metadata_only', 'none')),
    CONSTRAINT video_insights_status_valid
        CHECK (status IN ('ok', 'failed', 'skipped', 'quota_exceeded')),
    CONSTRAINT video_insights_view_count_valid
        CHECK (view_count IS NULL OR view_count >= 0),
    CONSTRAINT video_insights_game_uniq UNIQUE (game_id)
);

CREATE INDEX video_insights_game_idx ON video_insights (game_id);
