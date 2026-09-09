-- =============================================================================
-- 003_optional_pgvector
-- Опциональная поддержка семантического поиска (ADR-0009).
--
-- КЛЮЧЕВОЕ СВОЙСТВО: миграция НЕ ПАДАЕТ при отсутствии pgvector.
-- Стандартный образ postgres:16 расширения не содержит, а требование
-- Product/Tech Lead — не делать vector search обязательным для миграций.
-- Отсутствие расширения — штатный режим, работает fallback content_v1.
-- =============================================================================

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
        CREATE EXTENSION IF NOT EXISTS vector;

        CREATE TABLE IF NOT EXISTS game_embeddings (
            game_id     UUID         PRIMARY KEY
                REFERENCES games (id) ON DELETE CASCADE,
            embedding   vector(1536) NOT NULL,
            model       TEXT         NOT NULL,
            created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
        );

        -- Индекс приблизительного поиска ближайших соседей
        CREATE INDEX IF NOT EXISTS game_embeddings_vector_idx
            ON game_embeddings USING ivfflat (embedding vector_cosine_ops)
            WITH (lists = 100);

        RAISE NOTICE 'pgvector доступен: семантический поиск включён';
    ELSE
        RAISE NOTICE 'pgvector недоступен: используется content_v1 (это штатный режим)';
    END IF;
END
$$;
