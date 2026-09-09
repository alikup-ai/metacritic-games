-- =============================================================================
-- 008_reviews
--
-- Хранение отдельных отзывов и уточнение модели снимков (ADR-0012).
--
-- Существующая review_snapshots СОХРАНЯЕТСЯ: её роль уточняется до метаданных
-- набора (fingerprint, полнота, счётчики). Сами отзывы переезжают в отдельную
-- таблицу, потому что JSONB-массив не позволяет опознать конкретный отзыв,
-- отследить правку текста и отличить новый от изменившегося.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- reviews — отдельные отзывы
--
-- Идентичность различается по типу (исследование 2026-09-08):
--   user   -> внешний id (UUID), стабилен между запросами;
--   critic -> id ОТСУТСТВУЕТ, ключом служит слаг издания.
--
-- Платформа входит в ключ обязательно: проверено, что GameSpot и IGN
-- рецензировали Witcher 3 и на PC, и на Xbox One с одинаковой датой и
-- оценкой. Без платформы одна из рецензий была бы молча потеряна.
-- -----------------------------------------------------------------------------
CREATE TABLE reviews (
    id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id           UUID         NOT NULL REFERENCES games (id) ON DELETE CASCADE,
    kind              TEXT         NOT NULL,
    platform_slug     TEXT         NOT NULL,

    -- Ключ источника: заполнено ровно одно поле, в зависимости от kind
    external_id       TEXT,
    publication_slug  TEXT,

    -- NULL допустим: встречен критический отзыв без оценки
    score             SMALLINT,
    quote             TEXT         NOT NULL,
    author            TEXT,
    -- critic: у 3 из 93 проверенных URL отсутствует; user: не публикуется
    review_url        TEXT,
    review_date       DATE,
    -- user: поле version источника; critic: отсутствует
    source_version    BIGINT,
    spoiler           BOOLEAN,

    -- Обнаружение правки текста при неизменном ключе
    content_hash      TEXT         NOT NULL,
    first_seen_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_seen_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT reviews_kind_valid CHECK (kind IN ('critic', 'user')),

    -- Ключ источника обязателен и соответствует типу: смешать нельзя
    CONSTRAINT reviews_identity_valid CHECK (
        (kind = 'user'   AND external_id IS NOT NULL AND publication_slug IS NULL)
     OR (kind = 'critic' AND publication_slug IS NOT NULL AND external_id IS NULL)
    ),

    -- Шкалы различаются: критики 0-100, пользователи 0-10
    CONSTRAINT reviews_score_range CHECK (
        score IS NULL
     OR (kind = 'critic' AND score BETWEEN 0 AND 100)
     OR (kind = 'user'   AND score BETWEEN 0 AND 10)
    ),

    CONSTRAINT reviews_quote_not_empty CHECK (length(btrim(quote)) > 0),
    CONSTRAINT reviews_platform_not_empty CHECK (length(btrim(platform_slug)) > 0)
);

-- Два ЧАСТИЧНЫХ уникальных индекса вместо одного общего: ключи разных типов
-- лежат в разных колонках, и общий индекс по обеим допускал бы NULL-дыры
-- (в PostgreSQL NULL не конфликтует с NULL).
CREATE UNIQUE INDEX reviews_user_identity_idx
    ON reviews (game_id, platform_slug, external_id)
    WHERE kind = 'user';

CREATE UNIQUE INDEX reviews_critic_identity_idx
    ON reviews (game_id, platform_slug, publication_slug)
    WHERE kind = 'critic';

CREATE INDEX reviews_game_kind_idx ON reviews (game_id, kind, platform_slug);

COMMENT ON COLUMN reviews.external_id IS
    'UUID отзыва из источника; только для пользовательских отзывов';
COMMENT ON COLUMN reviews.publication_slug IS
    'Слаг издания; ключ критического отзыва, так как источник не даёт id';
COMMENT ON COLUMN reviews.content_hash IS
    'Хеш значимых полей: позволяет отличить правку текста от неизменного отзыва';

-- -----------------------------------------------------------------------------
-- review_snapshots — уточнение существующей таблицы
--
-- Отзывы теперь хранятся отдельно, поэтому колонка reviews становится
-- необязательной. Она НЕ удаляется: это сохранило бы совместимость, если
-- потребуется откат, и не мешает.
-- -----------------------------------------------------------------------------
ALTER TABLE review_snapshots
    -- Отзывы platform-specific (исследование): снимок делается по платформе
    ADD COLUMN platform_slug TEXT NOT NULL DEFAULT 'default',

    -- Полнота набора. Заменяет булев truncated, различая ТРИ состояния:
    --   complete   — получены все отзывы источника;
    --   partial    — сознательное ограничение лимитом (штатный режим);
    --   incomplete — обход прерван ошибкой (ДЕГРАДАЦИЯ).
    -- Различие важно: удалять исчезнувшие отзывы можно только при complete.
    ADD COLUMN completeness TEXT NOT NULL DEFAULT 'complete',

    -- totalResults источника: база для вычисления полноты
    ADD COLUMN total_available INTEGER,

    -- Число записей, которые не удалось разобрать
    ADD COLUMN malformed_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE review_snapshots
    ADD CONSTRAINT review_snapshots_completeness_valid
        CHECK (completeness IN ('complete', 'partial', 'incomplete')),
    ADD CONSTRAINT review_snapshots_malformed_valid CHECK (malformed_count >= 0),
    ADD CONSTRAINT review_snapshots_total_valid
        CHECK (total_available IS NULL OR total_available >= 0);

-- Снимок теперь уникален по тройке: платформа стала частью идентичности
ALTER TABLE review_snapshots
    DROP CONSTRAINT review_snapshots_game_kind_uniq;

ALTER TABLE review_snapshots
    ADD CONSTRAINT review_snapshots_game_kind_platform_uniq
        UNIQUE (game_id, kind, platform_slug);

-- Колонка reviews больше не обязательна: данные переехали в reviews
ALTER TABLE review_snapshots
    ALTER COLUMN reviews DROP NOT NULL,
    ALTER COLUMN reviews SET DEFAULT NULL;

COMMENT ON COLUMN review_snapshots.completeness IS
    'complete = все отзывы; partial = ограничено лимитом; incomplete = сбой обхода. '
    'Исчезнувшие отзывы удаляются ТОЛЬКО при complete';
COMMENT ON COLUMN review_snapshots.reviews IS
    'Устарело: отзывы хранятся в таблице reviews. Оставлено для совместимости';
