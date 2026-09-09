-- Обогащение игр видеообзорами (ADR-0005).
--
-- Таблица video_insights создана миграцией 001 как заготовка. Здесь
-- добавляются поля, которых не хватает для работы:
--   * transcript_hash — ключ идемпотентности: при неизменной расшифровке
--     повторный вызов модели не нужен;
--   * структурированный разбор вместо одного текстового вывода;
--   * сведения о ролике, которых не было (дата, длительность).
--
-- Сам текст расшифровки НЕ хранится: для работы достаточно отпечатка,
-- сведений о видео и результата разбора.

ALTER TABLE video_insights
    ADD COLUMN published_at       timestamptz,
    ADD COLUMN duration_seconds   integer,
    ADD COLUMN transcript_hash    text,
    ADD COLUMN summary            text,
    ADD COLUMN liked_items        jsonb,
    ADD COLUMN disliked_items     jsonb,
    ADD COLUMN themes             jsonb;

-- Длительность не может быть отрицательной
ALTER TABLE video_insights
    ADD CONSTRAINT video_insights_duration_valid
    CHECK (duration_seconds IS NULL OR duration_seconds >= 0);

-- Успешный разбор обязан иметь отпечаток расшифровки: иначе повторный
-- запуск не смог бы понять, изменилось ли содержимое, и либо вызывал бы
-- модель каждый раз, либо навсегда закреплял устаревший результат.
ALTER TABLE video_insights
    ADD CONSTRAINT video_insights_hash_required
    CHECK (status <> 'ok' OR transcript_hash IS NOT NULL);

-- Поиск по отпечатку при проверке идемпотентности
CREATE INDEX video_insights_transcript_hash_idx
    ON video_insights (game_id, transcript_hash)
    WHERE transcript_hash IS NOT NULL;
