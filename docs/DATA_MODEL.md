# Модель данных — Metacritic Games Service

**Версия:** 1.1
**Дата:** 2026-09-07
**СУБД:** PostgreSQL 16
**Статус:** источник истины по схеме БД

Документ описывает физическую модель данных. Решения обоснованы в ADR-0002, 0003, 0004,
0008, 0009, 0010. Политики хранения и повторов — `RETENTION_POLICY.md`, `RETRY_POLICY.md`.

---

## 1. Принципы

1. **Идемпотентность на уровне СУБД, а не приложения.** Ограничения уникальности делают
   двойную обработку физически невозможной, вместо того чтобы полагаться на дисциплину кода.
2. **Source metadata отделены от доменных полей** (ADR-0003): `source`, `source_slug`,
   `source_url`, `parser_version` — технические поля источника, они не смешиваются с
   `title`, `developer`, `description`.
3. **Никаких ложных связей.** Если достоверность данных ниже, чем кажется, это выражено в
   схеме явным полем (`*_scope`, `*_status`), а не подразумевается.
4. **Различие «нет данных» и «данные не получены».** `NULL` + статусное поле, а не
   молчаливый `NULL`.
5. **Отделение сырых данных от производных.** Отзывы (raw) и их LLM-резюме (derived)
   хранятся раздельно и обновляются независимо.
6. **Все временные метки — `TIMESTAMPTZ`.** `TIMESTAMP` без зоны — источник ошибок при
   работе с UTC-границей суток.

---

## 2. ER-диаграмма

```mermaid
erDiagram
    games ||--o{ game_platforms : "оценки по платформам"
    games ||--o{ review_snapshots : "снимки отзывов"
    games ||--o{ review_summaries : "LLM-резюме"
    games ||--o{ similar_games : "похожие (источник)"
    games ||--o{ similar_games : "похожие (цель)"
    games ||--o| video_insights : "заключение по летсплею"
    games ||--o{ game_embeddings : "эмбеддинг (опц.)"

    processing_days ||--o{ daily_claims : "план дня"
    runs ||--o{ daily_claims : "заявки запуска"
    runs ||--o{ run_events : "события"

    games {
        uuid id PK
        text source
        text source_slug
        text title
        text description
        text cover_url
        text trailer_url
        text developer "NULL допустим"
        text developer_status "resolved|unknown"
        text_array publishers
        text_array genres
        date release_date
        smallint metascore_overall
        numeric userscore_overall
        text content_hash
        text parser_version
        timestamptz first_seen_at
        timestamptz last_updated_at
    }

    game_platforms {
        uuid game_id PK_FK
        text platform_slug PK
        text platform_name
        smallint metascore "NULL при tbd"
        text metascore_scope "platform"
        numeric userscore
        text userscore_scope "overall"
        integer critic_count
        integer user_count
        timestamptz updated_at
    }

    processing_days {
        date day PK
        text phase "new_releases|browse|exhausted"
        integer browse_page
        boolean new_releases_done
        integer claimed_count
        timestamptz created_at
        timestamptz updated_at
    }

    daily_claims {
        date processing_day PK_FK
        text source PK
        text source_slug PK
        uuid game_id FK "NULL до первой записи"
        uuid run_id FK
        text status "pending|claimed|done|failed"
        timestamptz claimed_at
        timestamptz lease_until
        integer attempts
        jsonb stages
        text last_error
        timestamptz completed_at
        timestamptz updated_at
    }

    runs {
        uuid id PK
        text trigger "cron|manual"
        text status "running|completed|failed|skipped|blocked"
        timestamptz started_at
        timestamptz finished_at
        integer planned_count
        integer claimed_count
        integer processed_count
        integer failed_count
        text error
        timestamptz heartbeat_at
        text owner_id
        bigint lock_key
        timestamptz recovered_at
        text recovery_reason
    }

    run_events {
        bigserial id PK
        uuid run_id FK
        timestamptz ts
        text level "debug|info|warn|error"
        text stage
        text source_slug
        text message
        jsonb payload
    }

    review_snapshots {
        uuid id PK
        uuid game_id FK
        text kind "critic|user"
        jsonb reviews
        text fingerprint
        integer review_count
        timestamptz fetched_at
    }

    review_summaries {
        uuid id PK
        uuid game_id FK
        text kind "critic|user"
        text likes
        text dislikes
        text verdict
        text source_fingerprint
        integer source_review_count
        text model
        text prompt_version
        integer tokens_in
        integer tokens_out
        timestamptz generated_at
    }

    similar_games {
        uuid game_id PK_FK
        uuid similar_game_id PK_FK
        real score
        text method "content_v1|embedding_v1"
        jsonb factors
        timestamptz computed_at
    }

    video_insights {
        uuid id PK
        uuid game_id FK
        text video_id
        text video_url
        text video_title
        text channel_title
        bigint view_count
        text transcript_source "official|auto|metadata_only"
        text conclusion
        text model
        text prompt_version
        text status "ok|failed|skipped"
        text last_error
        timestamptz generated_at
    }

    game_embeddings {
        uuid game_id PK_FK
        text model
        timestamptz created_at
    }
```

> `game_embeddings` создаётся только при наличии pgvector (ADR-0009); колонка `embedding`
> имеет тип `vector` и потому не отражена в диаграмме.

---

## 3. Таблицы

### 3.1 `games`

Каталог игр. UUID как внутренний PK, `(source, source_slug)` как внешний ключ (ADR-0003).

| Колонка | Тип | NULL | Описание |
|---|---|---|---|
| `id` | `UUID` | NOT NULL | PK, `gen_random_uuid()` |
| `source` | `TEXT` | NOT NULL | Источник, по умолчанию `'metacritic'` |
| `source_slug` | `TEXT` | NOT NULL | Canonical slug |
| `source_url` | `TEXT` | NULL | Полный URL карточки |
| `title` | `TEXT` | NOT NULL | Название |
| `description` | `TEXT` | NULL | Описание |
| `cover_url` | `TEXT` | NULL | Обложка |
| `trailer_url` | `TEXT` | NULL | Ссылка на видео |
| `developer` | `TEXT` | **NULL** | Разработчик; `NULL` допустим (ADR-0003) |
| `developer_status` | `TEXT` | NOT NULL | `resolved` \| `unknown` |
| `publishers` | `TEXT[]` | NOT NULL | Издатели, по умолчанию `'{}'` |
| `genres` | `TEXT[]` | NOT NULL | Жанры, по умолчанию `'{}'` |
| `release_date` | `DATE` | NULL | Дата релиза (может быть будущей) |
| `metascore_overall` | `SMALLINT` | NULL | Агрегированный Metascore (для сортировки) |
| `userscore_overall` | `NUMERIC(3,1)` | NULL | Агрегированный Userscore |
| `content_hash` | `TEXT` | NULL | Хеш значимых полей — обнаружение изменений |
| `parser_version` | `TEXT` | NOT NULL | Версия парсера, которым извлечены данные |
| `first_seen_at` | `TIMESTAMPTZ` | NOT NULL | Первое появление; **не меняется при update** |
| `last_updated_at` | `TIMESTAMPTZ` | NOT NULL | Последнее обновление |

**Ограничения**
- `PRIMARY KEY (id)`
- `UNIQUE (source, source_slug)` — цель для `ON CONFLICT` при upsert
- `CHECK (developer_status IN ('resolved','unknown'))`
- `CHECK (developer_status <> 'resolved' OR developer IS NOT NULL)` — не позволяет пометить
  разработчика определённым при пустом значении
- `CHECK (metascore_overall BETWEEN 0 AND 100)`
- `CHECK (userscore_overall BETWEEN 0 AND 10)`
- `CHECK (length(title) > 0)`

**Индексы**
| Индекс | Назначение |
|---|---|
| `UNIQUE (source, source_slug)` | Upsert, поиск по слагу |
| `(metascore_overall DESC NULLS LAST)` | Сортировка по рейтингу |
| `(userscore_overall DESC NULLS LAST)` | Сортировка по оценке игроков |
| `(release_date DESC NULLS LAST)` | Сортировка по дате |
| `GIN (title gin_trgm_ops)` | Поиск по названию |
| `GIN (genres)` | Схожесть по жанрам |
| `(developer_status) WHERE developer_status='unknown'` | Мониторинг качества парсинга |

`parser_version` позволяет после смены разметки найти записи, извлечённые старым парсером,
и переобработать именно их.

---

### 3.2 `game_platforms`

Оценки по платформам (1..N). Раздельные scope для двух метрик (ADR-0008).

| Колонка | Тип | NULL | Описание |
|---|---|---|---|
| `game_id` | `UUID` | NOT NULL | FK → `games(id)` |
| `platform_slug` | `TEXT` | NOT NULL | Нормализованный код: `playstation-5` |
| `platform_name` | `TEXT` | NOT NULL | Отображаемое имя: `PlayStation 5` |
| `metascore` | `SMALLINT` | **NULL** | `NULL` при `tbd` |
| `metascore_scope` | `TEXT` | NOT NULL | `platform` (доказано) |
| `userscore` | `NUMERIC(3,1)` | NULL | Оценка игроков |
| `userscore_scope` | `TEXT` | NOT NULL | `overall` — Metacritic не даёт Userscore по платформам |
| `critic_count` | `INTEGER` | NULL | Число рецензий критиков |
| `user_count` | `INTEGER` | NULL | Число оценок игроков |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL | Обновление |

**Ограничения**
- `PRIMARY KEY (game_id, platform_slug)` — одна платформа встречается один раз
- `FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE`
- `CHECK (metascore_scope IN ('platform','overall','overall_fallback','derived'))`
- `CHECK (userscore_scope IN ('platform','overall','overall_fallback','derived'))`
- `CHECK (metascore BETWEEN 0 AND 100)`
- `CHECK (userscore BETWEEN 0 AND 10)`
- `CHECK (critic_count >= 0)`, `CHECK (user_count >= 0)`

**Индексы:** `(platform_slug)` для фильтра; `(platform_slug, metascore DESC NULLS LAST)`
для «лучшее на платформе».

**Почему `metascore` nullable при `scope='platform'`:** это означает «платформа известна,
оценки ещё нет (`tbd`)» — подтверждённое состояние (Elden Ring на PS4/Xbox One). Оно
отличается от «оценка есть, но не платформенная», и схема их различает.

---

### 3.3 `processing_days`

План на календарные сутки (ADR-0002).

| Колонка | Тип | NULL | Описание |
|---|---|---|---|
| `day` | `DATE` | NOT NULL | PK; вычисляется по `PROCESSING_TIMEZONE` (UTC) |
| `phase` | `TEXT` | NOT NULL | `new_releases` \| `browse` \| `exhausted` |
| `browse_page` | `INTEGER` | NOT NULL | Курсор страницы (подсказка, не истина) |
| `new_releases_done` | `BOOLEAN` | NOT NULL | Раздел New Releases обработан |
| `claimed_count` | `INTEGER` | NOT NULL | Заявлено игр за сутки (для мониторинга) |
| `created_at` / `updated_at` | `TIMESTAMPTZ` | NOT NULL | Метки |

**Ограничения**
- `PRIMARY KEY (day)`
- `CHECK (phase IN ('new_releases','browse','exhausted'))`
- `CHECK (browse_page >= 1)`
- `CHECK (claimed_count >= 0)`

Отсутствие строки на новую дату = сигнал «начать день заново». Создание — через
`INSERT ... ON CONFLICT (day) DO NOTHING`, поэтому гонка двух воркеров безопасна.

---

### 3.4 `daily_claims` — ядро идемпотентности

Реестр «обработано сегодня» + механизм claim/lease (ADR-0004).

| Колонка | Тип | NULL | Описание |
|---|---|---|---|
| `processing_day` | `DATE` | NOT NULL | Часть PK, FK → `processing_days(day)` |
| `source` | `TEXT` | NOT NULL | Часть PK |
| `source_slug` | `TEXT` | NOT NULL | Часть PK |
| `game_id` | `UUID` | NULL | FK → `games(id)`; `NULL` до первого сохранения игры |
| `run_id` | `UUID` | NULL | FK → `runs(id)`; текущий владелец |
| `status` | `TEXT` | NOT NULL | `pending` \| `claimed` \| `done` \| `failed` |
| `claimed_at` | `TIMESTAMPTZ` | NULL | Момент захвата |
| `lease_until` | `TIMESTAMPTZ` | NULL | Срок аренды; `NULL` при `done`/`failed` |
| `attempts` | `INTEGER` | NOT NULL | Число попыток |
| `stages` | `JSONB` | NOT NULL | Прогресс по стадиям |
| `last_error` | `TEXT` | NULL | Последняя ошибка |
| `completed_at` | `TIMESTAMPTZ` | NULL | Момент завершения |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL | Обновление |

**Ограничения**
- **`PRIMARY KEY (processing_day, source, source_slug)`** — требование Product/Tech Lead;
  делает двойной claim одной игры в сутки физически невозможным
- `FOREIGN KEY (processing_day) REFERENCES processing_days(day) ON DELETE CASCADE`
- `FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE SET NULL`
- `FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL`
- `CHECK (status IN ('pending','claimed','done','failed'))`
- `CHECK (attempts >= 0)`
- `CHECK (status <> 'claimed' OR lease_until IS NOT NULL)` — захваченная запись обязана
  иметь срок аренды, иначе она «зависнет» навсегда
- `CHECK (status <> 'done' OR completed_at IS NOT NULL)`

**Индексы**
| Индекс | Назначение |
|---|---|
| `(status, lease_until) WHERE status='claimed'` | Работа reaper — только активные аренды |
| `(processing_day, status)` | Счётчики прогресса дня |
| `(run_id)` | Элементы конкретного запуска |

**Формат `stages`:**
```json
{
  "fetchGame":    { "status": "done",    "at": "2026-09-07T10:00:05Z" },
  "fetchReviews": { "status": "done",    "at": "2026-09-07T10:00:12Z" },
  "summarize":    { "status": "failed",  "error": "timeout" },
  "similar":      { "status": "pending" },
  "youtube":      { "status": "skipped", "reason": "feature_disabled" }
}
```
JSONB выбран вместо отдельной таблицы: набор стадий меняется вместе с кодом, читается
всегда целиком и никогда не запрашивается независимо от claim.

#### Поведение в семи сценариях

| # | Сценарий | Переходы и результат |
|---|---|---|
| 1 | **Обычное завершение** | `INSERT` → `claimed` → стадии → `done`, `completed_at`, `lease_until=NULL` |
| 2 | **Падение worker** | Запись остаётся `claimed` с истёкшим `lease_until`; данные завершённых стадий сохранены |
| 3 | **Истечение lease** | Reaper: `claimed` + `lease_until < now()` → `pending`, `attempts+1`, `run_id=NULL`. **UPDATE существующей строки, не INSERT** |
| 4 | **Retry** | Новый run берёт `pending`, ставит `claimed`; выполненные стадии из `stages` пропускаются |
| 5 | **Дублирующий job** | `ON CONFLICT DO NOTHING` не возвращает строку → воркер пропускает игру |
| 6 | **Параллельные workers** | Блокировка строки в СУБД: `INSERT` выигрывает ровно один |
| 7 | **Частичное выполнение** | `stages` фиксирует прогресс; возобновление с первой незавершённой стадии |

Исчерпание попыток: `attempts >= MAX_ATTEMPTS` → `failed`. Игра перестаёт занимать место в
батче, но видна в мониторинге.

---

### 3.5 `runs`

| Колонка | Тип | NULL | Описание |
|---|---|---|---|
| `id` | `UUID` | NOT NULL | PK |
| `trigger` | `TEXT` | NOT NULL | `cron` \| `manual` |
| `status` | `TEXT` | NOT NULL | `running` \| `completed` \| `failed` \| `skipped` \| `blocked` |
| `started_at` | `TIMESTAMPTZ` | NOT NULL | Начало |
| `finished_at` | `TIMESTAMPTZ` | NULL | Окончание |
| `planned_count` | `INTEGER` | NOT NULL | Запланировано |
| `claimed_count` | `INTEGER` | NOT NULL | Заявлено |
| `processed_count` | `INTEGER` | NOT NULL | Успешно обработано |
| `failed_count` | `INTEGER` | NOT NULL | С ошибкой |
| `error` | `TEXT` | NULL | Причина завершения run |
| `heartbeat_at` | `TIMESTAMPTZ` | NOT NULL | Отметка живости; вторичный критерий orphaned run |
| `owner_id` | `TEXT` | NULL | Владелец (host:pid) — диагностика, не критерий живости |
| `lock_key` | `BIGINT` | NULL | Ключ advisory lock; наличие в `pg_locks` — основной критерий |
| `recovered_at` | `TIMESTAMPTZ` | NULL | Момент восстановления при старте |
| `recovery_reason` | `TEXT` | NULL | Причина восстановления (дублируется в `run_events`) |

**Ограничения:** `CHECK (status IN (...))`, счётчики `>= 0`,
`CHECK (status = 'running' OR finished_at IS NOT NULL)`.

**Восстановление осиротевших запусков (ADR-0010).** После аварийного завершения процесса
строка остаётся `running`, и частичный уникальный индекс блокирует все последующие запуски.
При старте выполняется recovery: запуск признаётся осиротевшим, если его `lock_key` не
удерживается в `pg_locks` (СУБД снимает advisory lock при обрыве сессии), либо — для строк
без `lock_key` — если `heartbeat_at` не обновлялся дольше таймаута. Критерий «running дольше
N минут» **не используется**: он ошибочно убивал бы долгие, но живые запуски.

**Индексы:** `(started_at DESC)`; `(heartbeat_at) WHERE status='running'` — отбор кандидатов
на восстановление; частичный `UNIQUE ((status)) WHERE status='running'` — **второй барьер**
против параллельных запусков в дополнение к advisory lock.

Статус `blocked` отделён от `failed`: блокировка со стороны Metacritic (403) требует иной
реакции, чем обычная ошибка (ADR по обработке ошибок).

---

### 3.6 `run_events`

Журнал событий: аудит + источник для SSE.

| Колонка | Тип | NULL | Описание |
|---|---|---|---|
| `id` | `BIGSERIAL` | NOT NULL | PK, монотонный — курсор для SSE |
| `run_id` | `UUID` | NOT NULL | FK → `runs(id)` ON DELETE CASCADE |
| `ts` | `TIMESTAMPTZ` | NOT NULL | Время |
| `level` | `TEXT` | NOT NULL | `debug` \| `info` \| `warn` \| `error` |
| `stage` | `TEXT` | NULL | Стадия пайплайна |
| `source_slug` | `TEXT` | NULL | Игра, если применимо |
| `message` | `TEXT` | NOT NULL | Сообщение |
| `payload` | `JSONB` | NULL | Детали |

**Индексы:** `(run_id, id DESC)` — лента событий запуска; `(ts DESC)` — очистка по времени.

`BIGSERIAL`, а не UUID: клиент SSE передаёт последний виденный `id` и получает только новые
события. С UUID это потребовало бы сортировки по времени с риском коллизий меток.

**Retention:** самая быстрорастущая таблица. Политика — §5.

---

### 3.7 `review_snapshots`

Сырые отзывы. Хранятся **отдельно** от резюме.

| Колонка | Тип | NULL | Описание |
|---|---|---|---|
| `id` | `UUID` | NOT NULL | PK |
| `game_id` | `UUID` | NOT NULL | FK → `games(id)` ON DELETE CASCADE |
| `kind` | `TEXT` | NOT NULL | `critic` \| `user` |
| `reviews` | `JSONB` | NOT NULL | Массив отзывов |
| `fingerprint` | `TEXT` | NOT NULL | Хеш набора — вход для fingerprint-gate |
| `review_count` | `INTEGER` | NOT NULL | Число отзывов |
| `truncated` | `BOOLEAN` | NOT NULL | Набор был усечён лимитом |
| `fetched_at` | `TIMESTAMPTZ` | NOT NULL | Время получения |

**Ограничения:** `UNIQUE (game_id, kind)` — один актуальный снимок каждого типа;
`CHECK (kind IN ('critic','user'))`, `CHECK (review_count >= 0)`.

`truncated` фиксирует, что резюме построено по части отзывов, — иначе выводы выглядели бы
основанными на полном наборе.

---

### 3.8 `review_summaries`

Производные LLM-резюме. Отделены от сырых данных.

| Колонка | Тип | NULL | Описание |
|---|---|---|---|
| `id` | `UUID` | NOT NULL | PK |
| `game_id` | `UUID` | NOT NULL | FK → `games(id)` ON DELETE CASCADE |
| `kind` | `TEXT` | NOT NULL | `critic` \| `user` — **summary type** |
| `likes` | `TEXT` | NULL | Что нравится |
| `dislikes` | `TEXT` | NULL | Что не нравится |
| `verdict` | `TEXT` | NULL | Общий вывод |
| `status` | `TEXT` | NOT NULL | `ok` \| `insufficient_reviews` \| `failed` |
| `source_fingerprint` | `TEXT` | NOT NULL | Отпечаток отзывов-источника |
| `source_review_count` | `INTEGER` | NOT NULL | Сколько отзывов использовано |
| `model` | `TEXT` | NOT NULL | Фактическая модель |
| `prompt_version` | `TEXT` | NOT NULL | Версия промпта |
| `tokens_in` / `tokens_out` | `INTEGER` | NULL | Расход токенов |
| `generated_at` | `TIMESTAMPTZ` | NOT NULL | Время генерации |

**Ограничения:** `UNIQUE (game_id, kind)`; `CHECK (kind IN ('critic','user'))`;
`CHECK (status IN ('ok','insufficient_reviews','failed'))`;
`CHECK (status <> 'ok' OR likes IS NOT NULL OR dislikes IS NOT NULL)`.

`source_fingerprint` — механизм fingerprint-gate: совпадение с текущим отпечатком отзывов
означает, что вызов LLM не нужен. `model` и `prompt_version` обязательны: без них
невозможно понять, чем и по какому промпту сгенерирована конкретная запись после смены
модели (ADR-0006).

`status = 'insufficient_reviews'` отличает «отзывов не было» от «генерация не удалась» —
для новых инди-игр это типичное состояние, а не ошибка.

---

### 3.9 `similar_games`

Похожие игры; метод фиксируется в строке (ADR-0009).

| Колонка | Тип | NULL | Описание |
|---|---|---|---|
| `game_id` | `UUID` | NOT NULL | FK → `games(id)` ON DELETE CASCADE |
| `similar_game_id` | `UUID` | NOT NULL | FK → `games(id)` ON DELETE CASCADE |
| `score` | `REAL` | NOT NULL | Схожесть 0..1 |
| `method` | `TEXT` | NOT NULL | `content_v1` \| `embedding_v1` |
| `factors` | `JSONB` | NULL | Вклад факторов — объяснимость |
| `computed_at` | `TIMESTAMPTZ` | NOT NULL | Время расчёта |

**Ограничения**
- `PRIMARY KEY (game_id, similar_game_id)`
- `CHECK (game_id <> similar_game_id)` — игра не похожа на себя
- `CHECK (score >= 0 AND score <= 1)`
- `CHECK (method IN ('content_v1','embedding_v1'))`

**Индексы:** `(game_id, score DESC)` — выборка топ-N для карточки.

Связь **направленная**: A→B и B→A хранятся отдельными строками. Это допускает
несимметричные метрики и упрощает выборку, ценой примерно двукратного объёма — приемлемо
при таких масштабах.

`factors` даёт возможность объяснить подбор («совпали жанр и разработчик») — полезно и для
UI, и для отладки качества.

---

### 3.10 `video_insights`

Результат YouTube-обогащения (ADR-0005).

| Колонка | Тип | NULL | Описание |
|---|---|---|---|
| `id` | `UUID` | NOT NULL | PK |
| `game_id` | `UUID` | NOT NULL | FK → `games(id)` ON DELETE CASCADE |
| `video_id` | `TEXT` | NULL | ID ролика |
| `video_url` | `TEXT` | NULL | Ссылка (требование ТЗ) |
| `video_title` | `TEXT` | NULL | Заголовок |
| `channel_title` | `TEXT` | NULL | Канал |
| `view_count` | `BIGINT` | NULL | Просмотры — критерий «самый популярный» |
| `transcript_source` | `TEXT` | NOT NULL | `official` \| `auto` \| `metadata_only` \| `none` |
| `conclusion` | `TEXT` | NULL | Заключение |
| `model` | `TEXT` | NULL | Модель |
| `prompt_version` | `TEXT` | NULL | Версия промпта |
| `status` | `TEXT` | NOT NULL | `ok` \| `failed` \| `skipped` \| `quota_exceeded` |
| `last_error` | `TEXT` | NULL | Ошибка |
| `generated_at` | `TIMESTAMPTZ` | NULL | Время генерации |

**Ограничения:** `UNIQUE (game_id)`; `CHECK (transcript_source IN (...))`;
`CHECK (status IN (...))`; `CHECK (view_count >= 0)`.

`transcript_source` обязателен и отображается в UI: сервис не должен подразумевать, что
расшифровал речь, если использовал только метаданные.

---

### 3.11 `game_embeddings` (опционально)

Создаётся **только при наличии pgvector** (ADR-0009). Отсутствие расширения не ломает
миграции.

| Колонка | Тип | Описание |
|---|---|---|
| `game_id` | `UUID` | PK, FK → `games(id)` ON DELETE CASCADE |
| `embedding` | `vector(1536)` | Вектор |
| `model` | `TEXT` | Модель эмбеддинга |
| `created_at` | `TIMESTAMPTZ` | Время |

---

## 4. Целостность и жизненный цикл

### Статусные поля

| Таблица | Поле | Назначение |
|---|---|---|
| `games` | `developer_status` | Отличить «нет разработчика» от «не распознан» |
| `game_platforms` | `metascore_scope`, `userscore_scope` | Достоверность привязки к платформе |
| `daily_claims` | `status` | Жизненный цикл claim |
| `runs` | `status` | Жизненный цикл запуска |
| `review_summaries` | `status` | Отличить «мало отзывов» от «сбой» |
| `video_insights` | `status`, `transcript_source` | Результат и его основание |

### Каскады

`ON DELETE CASCADE` — от `games` ко всем дочерним. `daily_claims.game_id` —
`ON DELETE SET NULL`: удаление игры не должно стирать исторический факт её обработки.

---

## 5. Retention

| Таблица | Рост | Политика |
|---|---|---|
| `games` | ~480/день макс. | Не удаляем — основная ценность |
| `game_platforms` | ~3× от games | Живёт с игрой |
| `run_events` | **Самый быстрый** | **Удалять старше 30 дней** |
| `daily_claims` | ~480/день | Удалять старше 90 дней |
| `processing_days` | 1/день | Не удаляем |
| `runs` | 24/день | Удалять старше 90 дней |
| `review_snapshots` | 2/игра | Хранить только актуальный снимок |
| `review_summaries` | 2/игра | Хранить актуальное |
| `similar_games` | N×20 | Перезаписывается при пересчёте |

`run_events` — единственная таблица, требующая обязательной очистки: при активной работе она
растёт на тысячи строк в сутки. Очистка реализуется отдельной задачей (не в MVP-коде, но
предусмотрена в схеме и документации).

---

## 6. Расширения PostgreSQL

| Расширение | Обязательное | Назначение |
|---|---|---|
| `pgcrypto` | Да | `gen_random_uuid()` |
| `pg_trgm` | Да | Поиск по названию, схожесть |
| `vector` | **Нет** | Эмбеддинги; при отсутствии — `NOTICE`, миграция проходит |

`pgcrypto` и `pg_trgm` входят в стандартный образ `postgres:16` (contrib), поэтому
`docker compose up` работает без кастомного образа.

---

## 7. Соответствие требованиям

| Требование | Реализация |
|---|---|
| PK идемпотентности `(processing_day, source, source_slug)` | `daily_claims` |
| Безопасный конкурентный claim | `INSERT ... ON CONFLICT DO NOTHING` + блокировка строки |
| Поля lease/recovery | `claimed_at`, `lease_until`, `status`, `attempts`, `last_error`, `completed_at` |
| UUID PK для games | `games.id` |
| `UNIQUE(source, source_slug)` | Есть |
| developer и publisher раздельно | `developer` + `publishers[]` |
| Source metadata отдельно от домена | `source`, `source_slug`, `source_url`, `parser_version` |
| Нет ложной связи score → platform | `metascore_scope` / `userscore_scope` |
| Несколько платформ | PK `(game_id, platform_slug)` |
| Summary отдельно от raw reviews | `review_snapshots` vs `review_summaries` |
| Summary type, model, prompt_version, generated_at, source_review_count | Есть в `review_summaries` |
| pgvector опционален | Условная миграция (ADR-0009) |
| Простой fallback схожести | `content_v1` в `similar_games.method` |
