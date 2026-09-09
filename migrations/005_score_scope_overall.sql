-- =============================================================================
-- 005_score_scope_overall
--
-- Разводит два состояния, которые ранее сваливались в 'overall_fallback':
--
--   'overall'          — источник ПУБЛИКУЕТ только общую оценку по игре.
--                        Нормальное состояние. Пример: Userscore на Metacritic
--                        по платформам не публикуется вовсе (исследование OQ-18).
--
--   'overall_fallback' — источник, вероятно, публикует оценку по платформам,
--                        но связать её достоверно НЕ УДАЛОСЬ. Деградация,
--                        сигнал о возможной смене разметки.
--
-- Различие принципиально: первое не требует внимания, второе требует.
-- Один общий термин делал бы рост числа неудачных разборов невидимым.
-- =============================================================================

ALTER TABLE game_platforms
    DROP CONSTRAINT game_platforms_metascore_scope_valid,
    DROP CONSTRAINT game_platforms_userscore_scope_valid;

ALTER TABLE game_platforms
    ADD CONSTRAINT game_platforms_metascore_scope_valid
        CHECK (metascore_scope IN ('platform', 'overall', 'overall_fallback', 'derived')),
    ADD CONSTRAINT game_platforms_userscore_scope_valid
        CHECK (userscore_scope IN ('platform', 'overall', 'overall_fallback', 'derived'));

-- Значение по умолчанию для Userscore — 'overall': Metacritic не публикует
-- пользовательскую оценку по платформам, и это штатное положение дел.
ALTER TABLE game_platforms
    ALTER COLUMN userscore_scope SET DEFAULT 'overall';

-- Существующих строк на момент миграции нет (foundation ещё не наполнялся),
-- но приведение выполняется явно — на случай применения к непустой БД.
UPDATE game_platforms
SET userscore_scope = 'overall'
WHERE userscore_scope = 'overall_fallback';

COMMENT ON COLUMN game_platforms.metascore_scope IS
    'platform = оценка этой платформы (доказано); overall = источник даёт только общую; '
    'overall_fallback = связать не удалось (деградация); derived = рассчитано нами';
COMMENT ON COLUMN game_platforms.userscore_scope IS
    'Для Metacritic всегда overall: пользовательская оценка по платформам не публикуется';
