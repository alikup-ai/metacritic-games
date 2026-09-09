-- Внешние источники расшифровки.
--
-- Прежнее ограничение допускало только субтитры самого YouTube. С
-- появлением внешнего поставщика нужно различать, откуда получен текст:
--   * official / auto       — субтитры YouTube (ручные / автоматические);
--   * external_captions     — субтитры, полученные внешним сервисом;
--   * external_asr          — распознавание речи внешним сервисом;
--   * metadata_only / none  — расшифровки нет.
--
-- Различение существенно: точность у ручных субтитров и у распознанной
-- речи разная, и выводы по ним имеют разный вес.
--
-- Существующие записи не затрагиваются: прежние значения остаются
-- допустимыми, пересчёт данных не требуется.

ALTER TABLE video_insights
    DROP CONSTRAINT video_insights_transcript_source_valid;

ALTER TABLE video_insights
    ADD CONSTRAINT video_insights_transcript_source_valid
    CHECK (transcript_source IN (
        'official',
        'auto',
        'external_captions',
        'external_asr',
        'metadata_only',
        'none'
    ));
