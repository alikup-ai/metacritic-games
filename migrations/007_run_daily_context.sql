-- =============================================================================
-- 007_run_daily_context
--
-- Запуск обработки должен быть самодостаточно описан: к каким суткам он
-- относился, откуда брал кандидатов и на какой странице остановился.
-- Без этого разбор инцидента требует сопоставления по времени, что
-- ненадёжно при пересечении запусков.
-- =============================================================================

ALTER TABLE runs
    -- Сутки, к которым относится запуск. NULL у запусков, созданных до
    -- этой миграции, и у запусков, упавших до определения дня.
    ADD COLUMN processing_day DATE,
    -- Откуда брались кандидаты: new_releases | browse | mixed
    ADD COLUMN source_strategy TEXT,
    -- Страница листинга, на которой запуск остановился. Подсказка для
    -- диагностики; источником истины остаётся daily_claims (ADR-0002).
    ADD COLUMN last_page_hint INTEGER,
    -- Сколько страниц листинга было прочитано за запуск
    ADD COLUMN pages_scanned INTEGER NOT NULL DEFAULT 0;

ALTER TABLE runs
    ADD CONSTRAINT runs_source_strategy_valid
        CHECK (
            source_strategy IS NULL
            OR source_strategy IN ('new_releases', 'browse', 'mixed')
        ),
    ADD CONSTRAINT runs_pages_scanned_valid CHECK (pages_scanned >= 0);

CREATE INDEX runs_processing_day_idx ON runs (processing_day, started_at DESC);

COMMENT ON COLUMN runs.processing_day IS
    'Сутки обработки в конфигурируемой таймзоне (по умолчанию UTC)';
COMMENT ON COLUMN runs.last_page_hint IS
    'Страница листинга на момент завершения. Подсказка, не источник истины';

-- -----------------------------------------------------------------------------
-- Защита от гонки reaper и heartbeat.
--
-- Частичный индекс ускоряет выборку кандидатов на восстановление: reaper
-- обходит только захваченные заявки с истёкшей арендой, а не всю таблицу.
-- -----------------------------------------------------------------------------
CREATE INDEX daily_claims_expired_idx
    ON daily_claims (lease_until)
    WHERE status = 'claimed' AND lease_until IS NOT NULL;
