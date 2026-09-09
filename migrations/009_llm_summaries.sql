-- =============================================================================
-- 009_llm_summaries
--
-- Расширение review_summaries под анализ LLM (ADR-0013).
-- Новая таблица НЕ создаётся: существующая уже содержит model,
-- prompt_version, source_fingerprint, tokens_in/out и статусы.
--
-- РАСХОЖДЕНИЕ С ПЕРВОНАЧАЛЬНЫМ ADR, разрешённое здесь:
-- ADR-0013 предполагал наполнять likes/dislikes (TEXT) из массивов модели.
-- Но требование обязательных evidenceRefs означает, что каждый пункт несёт
-- ссылки на отзывы; при укладке в TEXT они терялись бы, и проверить вывод
-- было бы нельзя. Поэтому структура хранится в JSONB (liked_items,
-- disliked_items), а TEXT остаётся производным полем для отображения.
-- =============================================================================

ALTER TABLE review_summaries
    -- Платформа входит в идентичность, как у отзывов (ADR-0012)
    ADD COLUMN platform_slug TEXT NOT NULL DEFAULT 'default',

    -- Ключ идемпотентности: снимок + выборка + промпт + модель
    ADD COLUMN input_hash TEXT,
    ADD COLUMN sampling_version TEXT,

    -- Полнота анализа. coverage вычисляется НАШИМ кодом, не моделью.
    ADD COLUMN analyzed_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN total_available INTEGER,
    ADD COLUMN snapshot_completeness TEXT,
    ADD COLUMN coverage TEXT,

    ADD COLUMN confidence TEXT,

    -- Структурированный вывод со ссылками на отзывы
    ADD COLUMN liked_items JSONB,
    ADD COLUMN disliked_items JSONB,
    ADD COLUMN themes JSONB,

    ADD COLUMN last_error TEXT,
    ADD COLUMN error_category TEXT;

ALTER TABLE review_summaries
    ADD CONSTRAINT review_summaries_coverage_valid
        CHECK (coverage IS NULL OR coverage IN ('all_reviews', 'sample')),
    ADD CONSTRAINT review_summaries_confidence_valid
        CHECK (confidence IS NULL OR confidence IN ('low', 'medium', 'high')),
    ADD CONSTRAINT review_summaries_completeness_valid
        CHECK (
            snapshot_completeness IS NULL
         OR snapshot_completeness IN ('complete', 'partial', 'incomplete')
        ),
    ADD CONSTRAINT review_summaries_analyzed_valid CHECK (analyzed_count >= 0),
    ADD CONSTRAINT review_summaries_total_valid
        CHECK (total_available IS NULL OR total_available >= 0),
    -- Успешный анализ обязан нести ключ идемпотентности: без него повторный
    -- обход не смог бы определить, актуален ли результат.
    ADD CONSTRAINT review_summaries_hash_required
        CHECK (status <> 'ok' OR input_hash IS NOT NULL);

-- Идентичность резюме расширяется платформой
ALTER TABLE review_summaries
    DROP CONSTRAINT review_summaries_game_kind_uniq;

ALTER TABLE review_summaries
    ADD CONSTRAINT review_summaries_identity_uniq
        UNIQUE (game_id, kind, platform_slug);

-- Поиск актуального резюме по ключу идемпотентности
CREATE INDEX review_summaries_input_hash_idx
    ON review_summaries (game_id, kind, platform_slug, input_hash)
    WHERE input_hash IS NOT NULL;

COMMENT ON COLUMN review_summaries.input_hash IS
    'sha256(снимок + выборка + версия выборки + версия промпта + модель). '
    'Совпадение при status=ok означает, что вызов модели не нужен';
COMMENT ON COLUMN review_summaries.coverage IS
    'all_reviews | sample. Вычисляется приложением, НЕ моделью';
COMMENT ON COLUMN review_summaries.liked_items IS
    'Массив {text, evidenceRefs[]} — ссылки на отзывы, обосновывающие пункт';
COMMENT ON COLUMN review_summaries.likes IS
    'Производное от liked_items текстовое представление для отображения';
