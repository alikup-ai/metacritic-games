# Архитектура — Metacritic Games Service

**Версия:** 1.1
**Дата:** 2026-09-07
**Статус:** утверждена Product/Tech Lead

> Детальная схема БД вынесена в **`DATA_MODEL.md`** (источник истины по таблицам,
> индексам и ограничениям). Здесь приведён только обзор.

Документ описывает целевую архитектуру. Все ключевые решения зафиксированы в `docs/ADR/`.
Факты, помеченные **[ПРОВЕРЕНО]**, подтверждены живыми запросами к Metacritic 2026-09-07.

---

## 1. Обзор системы

Сервис ежечасно обходит Metacritic, забирает 20 ранее не обработанных за текущие сутки игр,
обогащает их данными (отзывы, LLM-резюме, похожие игры, опционально YouTube) и отдаёт через
веб-интерфейс с фильтрацией, поиском, сортировкой и realtime-мониторингом.

### Архитектурный стиль

**Модульный монолит** с разделением **domain / application / infrastructure**
(ADR-0001). Микросервисы не используются. Внешние интеграции скрыты за портами и
адаптерами — доменный слой не знает ни про HTTP, ни про PostgreSQL, ни про провайдера LLM.

```
┌──────────────────────────────────────────────────────────────────┐
│                        Next.js (SSR + UI)                        │
│   Список · Карточка игры · Фильтры/Поиск · Дашборд мониторинга   │
└───────────────┬──────────────────────────────┬───────────────────┘
                │ REST (чтение)                │ SSE (события)
┌───────────────▼──────────────────────────────▼───────────────────┐
│                    API Layer (Node.js + TS)                      │
│   /api/games · /api/games/:slug · /api/platforms                 │
│   /api/runs (POST — защищён auth) · /api/status · /api/events    │
├──────────────────────────────────────────────────────────────────┤
│                      APPLICATION LAYER                           │
│   IngestionOrchestrator · ProcessingDayService · RunService      │
│   Use cases: PlanBatch · ProcessGame · Summarize · FindSimilar   │
├──────────────────────────────────────────────────────────────────┤
│                        DOMAIN LAYER                              │
│   Game · GamePlatform · ProcessingDay · DailyClaim · Run         │
│   Правила: day-plan, claim/lease, идентичность, политика ошибок  │
│   Порты: GameCatalogSource · ReviewSource · LlmProvider ·        │
│          VideoProvider · GameRepository · ClaimRepository        │
├──────────────────────────────────────────────────────────────────┤
│                    INFRASTRUCTURE LAYER                          │
│   MetacriticAdapter · PostgresRepositories · LlmAdapter ·        │
│   YouTubeAdapter · Scheduler · HttpClient · EventBus · Logger    │
└───────────────┬──────────────────────┬───────────────────────────┘
                │                      │
        ┌───────▼────────┐    ┌────────▼─────────┐
        │  PostgreSQL    │    │ Внешние сервисы  │
        │                │    │ Metacritic · LLM │
        │                │    │ YouTube (flag)   │
        └────────────────┘    └──────────────────┘
```

### Ключевое подтверждённое решение: без headless-браузера

Discovery подтвердил **[ПРОВЕРЕНО]**, что все нужные страницы Metacritic —
листинги, карточка игры и **обе** страницы отзывов — отдаются server-side рендерингом и
доступны обычным HTTP-запросом. Playwright не требуется. Это убирает основной источник
затрат и нестабильности и соответствует требованию «не использовать headless browser без
доказанной необходимости».

---

## 2. Структура модулей

```
src/
├── modules/
│   ├── catalog/                 # Домен игр
│   │   ├── domain/              # Game, GamePlatform, value objects, правила
│   │   ├── application/         # use cases: upsert, поиск, выборка
│   │   └── infrastructure/      # PostgresGameRepository
│   │
│   ├── ingestion/               # Ядро обработки
│   │   ├── domain/              # ProcessingDay, DailyClaim, BatchPlan, Lease
│   │   ├── application/         # PlanBatch, ProcessGame, ClaimGames, ReapStale
│   │   └── infrastructure/      # MetacriticAdapter, парсеры, репозитории
│   │
│   ├── reviews/                 # Отзывы + LLM-резюме
│   │   ├── domain/              # Review, ReviewSummary, Fingerprint
│   │   ├── application/         # FetchReviews, SummarizeReviews
│   │   └── infrastructure/      # ReviewParser, LlmAdapter
│   │
│   ├── similarity/              # Похожие игры
│   │   ├── domain/              # SimilarityScore, алгоритм
│   │   ├── application/         # ComputeSimilarGames
│   │   └── infrastructure/      # PostgresSimilarityRepository
│   │
│   ├── video/                   # YouTube (опционально, feature flag)
│   │   ├── domain/              # VideoInsight, TranscriptSource
│   │   ├── application/         # FindLetsPlay, BuildConclusion
│   │   └── infrastructure/      # YouTubeAdapter, TranscriptAdapter
│   │
│   └── monitoring/              # Наблюдаемость и управление
│       ├── domain/              # Run, RunEvent, WorkerState
│       ├── application/         # StartRun, TrackProgress
│       └── infrastructure/      # SseGateway, PostgresRunRepository
│
├── shared/
│   ├── kernel/                  # Result, DomainError, типы идентификаторов
│   ├── http/                    # HttpClient: timeout, retry, rate limit
│   ├── config/                  # Загрузка и валидация конфигурации
│   ├── logging/                 # Структурные логи, AI-транскрипты
│   └── db/                      # Пул подключений, миграции, advisory locks
│
└── app/
    ├── api/                     # HTTP-роуты (тонкий слой)
    ├── scheduler/               # Ежечасный триггер
    └── bootstrap/               # Composition root: сборка зависимостей
```

### Правила зависимостей (проверяются линтером в CI)

```
domain          → не зависит ни от чего (чистый TypeScript)
application     → зависит только от domain
infrastructure  → реализует порты domain
app             → связывает всё в composition root
```

- `domain` **не имеет** импортов из `infrastructure`, `pg`, `axios`, SDK провайдеров.
- Межмодульное взаимодействие — только через application-слой, не через чужие репозитории.
- Нарушение правил = падение сборки (`dependency-cruiser`), а не замечание на ревью.

---

## 3. Основные сущности

### Доменная модель

| Сущность | Назначение | Ключевые поля |
|---|---|---|
| **Game** | Игра в каталоге | `id` (UUID), `source`, `sourceSlug`, `title`, `description`, `coverUrl`, `trailerUrl`, `developer`, `developerStatus`, `publisher`, `genres[]`, `releaseDate` |
| **GamePlatform** | Оценки по платформе (1..N) | `gameId`, `platformSlug`, `metascore`, `userscore`, `scoreScope` |
| **ProcessingDay** | План на календарные сутки | `day`, `phase`, `browsePage`, `newReleasesDone` |
| **DailyClaim** | Реестр «обработано сегодня» | `day`, `source`, `sourceSlug`, `status`, `leaseExpiresAt`, `attempts`, `stages` |
| **Run** | Запуск обработки | `id`, `trigger`, `status`, счётчики, `startedAt/finishedAt` |
| **RunEvent** | Событие для аудита и realtime | `runId`, `ts`, `level`, `stage`, `message` |
| **ReviewSnapshot** | Снимок отзывов | `gameId`, `kind`, `reviews[]`, `fingerprint` |
| **ReviewSummary** | LLM-резюме | `gameId`, `kind`, `likes`, `dislikes`, `verdict`, `sourceFingerprint` |
| **SimilarGame** | Похожая игра | `gameId`, `similarGameId`, `score`, `method` |
| **VideoInsight** | Итог по летсплею | `gameId`, `videoUrl`, `conclusion`, `transcriptSource` |

### Идентичность игры (ADR-0003)

- **Внутренний PK:** `UUID` — стабилен, не зависит от источника.
- **Внешний natural key:** `UNIQUE (source, source_slug)`, где `source = 'metacritic'`.
- Title **никогда** не используется как ключ: ремейки и переиздания дают коллизии.

### Developer vs Publisher — правило, подтверждённое исследованием

Проверка 4 игр **[ПРОВЕРЕНО]** показала:

| Игра | developer | publisher (JSON-LD) |
|---|---|---|
| elden-ring | From Software | Bandai Namco Games, **From Software** |
| halloween-the-game | IllFonic | Gun Interactive, **IllFonic** |
| the-blood-of-dawnwalker | **отсутствует** | Bandai Namco Games |

- `developer` извлекается из `data-testid="hero-summary-developer"` (присутствовал 4/4).
- `publisher` — из JSON-LD; он **смешивает** издателя и разработчика в один список, поэтому
  использовать его как developer недопустимо.
- Если developer отсутствует → `developer = null`, `developerStatus = 'unknown'`, запись в
  ingestion log. **Подмена запрещена на уровне кода** (ADR-0003).
- UI при `unknown` показывает «Разработчик не указан», а не издателя.

### Схема БД (ключевое)

```sql
game (
  id UUID PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'metacritic',
  source_slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  cover_url TEXT,
  trailer_url TEXT,
  developer TEXT,                          -- NULL допустим
  developer_status TEXT NOT NULL,          -- 'resolved' | 'unknown'
  publisher TEXT[],
  genres TEXT[],
  release_date DATE,
  metascore_overall INT,                   -- денормализация для сортировки
  userscore_numeric NUMERIC(3,1),
  first_seen_at TIMESTAMPTZ,
  last_updated_at TIMESTAMPTZ,
  UNIQUE (source, source_slug)
);

game_platforms (                           -- см. DATA_MODEL.md
  game_id UUID REFERENCES games(id) ON DELETE CASCADE,
  platform_slug TEXT,
  metascore SMALLINT,                      -- NULL при 'tbd'
  metascore_scope TEXT NOT NULL,           -- 'platform' (доказано, ADR-0008)
  userscore NUMERIC(3,1),
  userscore_scope TEXT NOT NULL,           -- 'overall' (ADR-0008)
  PRIMARY KEY (game_id, platform_slug)
);

processing_day (
  day DATE PRIMARY KEY,
  phase TEXT NOT NULL,                     -- 'new_releases' | 'browse' | 'exhausted'
  browse_page INT NOT NULL DEFAULT 1,
  new_releases_done BOOLEAN NOT NULL DEFAULT FALSE
);

daily_claim (                              -- ядро идемпотентности
  day DATE NOT NULL,
  source TEXT NOT NULL,
  source_slug TEXT NOT NULL,
  run_id UUID,
  status TEXT NOT NULL,                    -- 'claimed'|'done'|'failed'
  lease_expires_at TIMESTAMPTZ,
  attempts INT NOT NULL DEFAULT 0,
  stages JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (day, source, source_slug)   -- гарантия «одна игра в день»
);
```

`daily_claim` — центральный элемент корректности: одновременно реестр обработанного,
защита от дублей и механизм конкурентного доступа (ADR-0004).

---

## 4. Processing flow

### Ежечасный запуск

```
┌─ Триггер: cron (ежечасно) ИЛИ Force Run (защищён auth) ─┐
│                                                          │
▼
1. Попытка взять advisory lock (pg_try_advisory_lock)
   └─ не удалось → выход со статусом 'skipped' (уже идёт запуск)
                                                          
2. Определить processing_day по UTC (конфигурируемо)
   └─ строки нет → создать: phase='new_releases', browse_page=1
      (новый день начинается заново — требование ТЗ)
                                                          
3. Reaper: освободить протухшие claim (lease_expires_at < now)
   └─ status='claimed' и просрочен → вернуть в пул, attempts++
                                                          
4. Спланировать батч до 20 УСПЕШНО CLAIMED игр:
   ├─ phase='new_releases': первые 20 слагов с /game/
   │    └─ всё обработано сегодня → phase='browse'
   └─ phase='browse': страницы /browse/.../new/?page=N,
        цикл до набора 20 новых слагов, курсор сохраняется сразу
                                                          
5. Обработка пулом воркеров (4), с общим лимитом ≤1 req/s:
   для каждой игры — стадии с раздельным сохранением:
   ├─ fetchGame     → JSON-LD + DOM(developer) → upsert
   ├─ fetchReviews  → критики + пользователи → snapshot
   ├─ summarize     → 2 LLM-вызова (пропуск, если fingerprint совпал)
   ├─ similar       → пересчёт похожих
   └─ youtube       → только если feature flag включён
                                                          
6. Завершить run, освободить lock, записать итоговые счётчики
```

### Порядок источников (требование ТЗ)

1. Новый день → всегда сначала **New Releases** (`/game/`).
2. После обработки всех 20 → переход к **See All** (`/browse/.../new/`).
3. Каждый следующий запуск берёт **следующие** необработанные игры.
4. Курсор страницы сохраняется в `processing_day.browse_page`.
5. Существующая игра — **обновляется**, не создаётся заново (upsert по natural key).

### ⚠️ Подтверждённый риск: курсор страниц нестабилен во времени

**[ПРОВЕРЕНО, окончательно уточнено 2026-09-07]** История измерений:

1. Первое измерение: «17 из 33 ссылок» — **ошибка**, считались все ссылки `/game/<slug>/`,
   включая промо-блоки шапки, одинаковые на всех страницах.
2. Второе измерение (по карточкам): **0 пересечений** — но снимки делались по одному.
3. **Третье измерение (фикстуры, снятые с интервалом ~1.3 с): 5 пересечений из 20.**
   Игры сместились по позициям: 1→4, 2→3, 15→17, 16→18, 17→19.

Третий замер и есть решающий: он показывает **дрейф листинга во времени**, а не дубли
внутри одного снимка. Список отсортирован по дате релиза по убыванию и включает будущие
даты; новые игры непрерывно вставляются сверху, сдвигая остальные вправо. За 1.3 секунды
сместилось 5 из 20 позиций — за час между запусками сдвиг будет значительно больше.

**Следствие:** логика «одна страница за запуск» повторно читала бы уже обработанные игры и
**молча пропускала** другие, попавшие в «слепую зону» между снимками.

**Решение:** номер страницы — только *подсказка*. Источник истины — реестр `daily_claims`:
уже заявленные слаги отбрасываются, и планировщик листает страницы, пока не наберёт нужное
число действительно новых игр. Парсер при этом возвращает страницу как есть и не пытается
дедуплицировать между страницами — это ответственность оркестрации.

---

## 5. Claim / Retry / Recovery flow

### Двухфазный claim (ADR-0004)

```
ФАЗА 1 — CLAIM (атомарно, идемпотентно)
  INSERT INTO daily_claim (day, source, source_slug, run_id, status, lease_expires_at)
  VALUES (...)
  ON CONFLICT (day, source, source_slug) DO NOTHING
  RETURNING *;

  ├─ вернулась строка → игра захвачена этим воркером
  └─ пусто           → уже захвачена/обработана сегодня → пропустить

ФАЗА 2 — ОБРАБОТКА со стадийным сохранением
  каждая завершённая стадия немедленно пишется в stages JSONB
  lease продлевается пока воркер жив

ФАЗА 3 — ЗАВЕРШЕНИЕ
  UPDATE daily_claim SET status='done', lease_expires_at=NULL
```

Атомарность `INSERT ... ON CONFLICT DO NOTHING` даёт идемпотентность и защиту от гонок
одновременно: повторный запуск в тот же день физически не может создать дубль claim, что
прямо требуется решением по OQ-13.

### Гарантии при сбоях

| Сценарий | Гарантия | Механизм |
|---|---|---|
| **Перезапуск приложения** | Нет дублей и потерь | Всё состояние в PostgreSQL; advisory lock освобождается СУБД при разрыве сессии; план пересчитывается из БД |
| **Падение worker** | Игра будет повторена | Claim остаётся с истёкшим lease → reaper возвращает в пул, `attempts++` |
| **Повторный запуск job** | Безопасен | Claim идемпотентен; upsert игры идемпотентен |
| **Параллельные workers** | Нет двойной обработки | Атомарный claim на уровне строки: побеждает ровно один |
| **Частичная обработка** | Продолжает, не начинает заново | Стадии сохранены в `stages`; выполненные пропускаются при retry |

### Reaper (защита от «тихой потери»)

Без lease упавший воркер оставил бы игру в статусе `claimed` навсегда, и она **молча** не
была бы обработана в этот день. Reaper запускается в начале каждого run и возвращает
просроченные claim в пул. При превышении `max_attempts` claim помечается `failed` — игра не
блокирует прогресс и видна в мониторинге.

Важно: reaper **не создаёт** новый claim, а переиспользует существующую строку — требование
«retry без duplicate claim» выполняется буквально.

### Политика ошибок

Стадии `fetchGame`/`fetchReviews` — критичные: их провал завершает обработку игры неуспехом.
Стадии `summarize`/`similar`/`youtube` — обогащающие: их провал **никогда** не мешает
сохранить и показать игру. Одна плохая игра не должна ломать батч.

---

## 6. Границы Frontend / Backend

| Аспект | Frontend (Next.js) | Backend (Node.js) |
|---|---|---|
| Ответственность | Отображение, навигация, состояние UI | Бизнес-логика, ingestion, БД |
| Доступ к БД | **Нет** — только через API | Единственный владелец |
| Бизнес-правила | **Нет** | Все правила здесь |
| Данные | REST + SSE | Отдаёт DTO, не доменные объекты |
| Секреты | Никогда | Только на сервере |

**Контракт:** backend отдаёт DTO, доменные объекты наружу не покидают application-слой. Типы
DTO общие для фронта и бэка (единый TS-репозиторий) — контракт проверяется компилятором.

Публичные эндпоинты (чтение) и защищённые (запись) разделены:
`POST /api/runs` требует аутентификации (ADR по OQ-8), плюс rate limit.

**Untrusted input:** данные Metacritic и YouTube-транскрипты считаются недоверенными:
валидация на входе, экранирование при выводе, запрет `dangerouslySetInnerHTML`, allowlist
хостов для встраиваемого видео.

---

## 7. Внешние интеграции

Все интеграции скрыты за портами; доменный слой знает только интерфейс.

| Порт (domain) | Адаптер (infrastructure) | Назначение |
|---|---|---|
| `GameCatalogSource` | `MetacriticCatalogAdapter` | Листинги и карточки игр |
| `ReviewSource` | `MetacriticReviewAdapter` | Отзывы критиков и пользователей |
| `LlmProvider` | `OpenRouterLlmProvider` (ADR-0006) | Резюме и выводы |
| `VideoProvider` | `YouTubeAdapter` | Поиск летсплеев (feature flag) |
| `TranscriptProvider` | `CaptionsAdapter` | Транскрипт (graceful degradation) |

Замена провайдера = новый адаптер, без изменений в domain/application.

### Политика HTTP-запросов (обязательна для всех внешних вызовов)

- **Timeout** на каждый запрос (connect + total).
- **Retry:** 3 попытки, экспоненциальная задержка с jitter, только идемпотентные GET.
- **429:** уважать `Retry-After`, замедлить общий лимитер.
- **403 (блокировка):** **не** ретраить — прервать run со статусом `blocked`; повтор усугубит.
- **5xx:** ретрай как транзиентная ошибка.
- **Rate limit:** общий token bucket ≤1 req/s к Metacritic, независимо от числа воркеров.
- **Circuit breaker:** N подряд ошибок → досрочное завершение run с фиксацией причины.

### Стратегия парсинга

**JSON-LD — основной источник** (schema.org-контракт стабильнее CSS-классов), CSS/`data-testid`
— задокументированный fallback. Проверено, что JSON-LD даёт 6 из 7 требуемых полей
**[ПРОВЕРЕНО]**; developer берётся из DOM отдельно. Golden-file тесты на зафиксированных
HTML-фикстурах ловят редизайн Metacritic в CI, а не потерей данных в проде.

---

## 8. Планировщик и конкурентность

Три независимых уровня:

1. **Уровень run:** глобально не более одного запуска — advisory lock PostgreSQL.
   Защищает от коллизии cron + Force Run и от двух инстансов приложения.
2. **Уровень элемента:** пул воркеров (по умолчанию 4), безопасен благодаря атомарному claim.
3. **Уровень сети:** общий token bucket. Вежливость не зависит от числа воркеров —
   увеличение параллелизма не увеличивает нагрузку на Metacritic.

Пропущенные тики (приложение было выключено) **не** навёрстываются: план вычисляется из
состояния БД, поэтому следующий обычный запуск автоматически корректен.

---

## 9. Мониторинг (обязательная доп. часть 2)

- **Транспорт:** SSE (server→client), автопереподключение.
- **Схема:** стадии публикуют события → сохранение в `run_event` → рассылка подписчикам.
  Сохранение **до** рассылки позволяет клиенту, подключившемуся в середине, увидеть историю,
  а не пустой экран.
- **Дашборд:** текущий run и триггер, состояния воркеров, счётчики, план дня (фаза, курсор,
  обработано сегодня), лента событий, последняя ошибка.
- **Force Run:** `POST /api/runs` → `202` с id запуска либо `409`, если lock занят.
- **Health:** `/healthz`, `/readyz`.

---

## 10. Безопасность

- Секреты только через environment; `.env.example` документирует переменные.
- **Write-эндпоинты защищены `X-Admin-Token`** с constant-time сравнением + rate limit
  (ADR-0007). Токен не логируется.
- Валидация всех входных параметров (zod), параметризованные SQL-запросы.
- Scraped-контент и транскрипты — недоверенный ввод: экранирование при рендере,
  allowlist хостов для видео, защита от SSRF.
- Секреты **не попадают** в промпты и AI-логи by design (см. OQ-19), поэтому требование
  «raw logs не редактируются» выполняется без конфликта с безопасностью.

---

## 11. Развёртывание

**Docker Compose на VPS** (решение по OQ-15):

```
services:
  app       — Next.js + API + scheduler (один процесс)
  postgres  — БД с volume для персистентности
  proxy     — reverse proxy + TLS
```

Стабильный исходящий IP полезен для scraping. Миграции применяются при старте. Логи —
структурный JSON. Оркестраторы и очереди на MVP не вводятся.

---

## 12. Соответствие архитектурным требованиям

| Требование | Как выполнено |
|---|---|
| Без микросервисов | Модульный монолит (ADR-0001) |
| domain/application/infrastructure | Раскладка модулей + проверка зависимостей в CI |
| Интеграции за интерфейсами | Порты в domain, адаптеры в infrastructure |
| Scraped/transcript = untrusted | Валидация на входе, экранирование на выходе |
| Идемпотентные background jobs | Двухфазный claim + upsert (ADR-0004) |
| Timeout/retry/403/429/5xx | Единый HttpClient с явной политикой (§7) |
| Без headless browser | Доказано ненужным **[ПРОВЕРЕНО]** |
| Assumptions в документации | DISCOVERY.md, OPEN_QUESTIONS.md, ADR |
| Не изобретать selectors | OQ-18 оставлен открытым до исследования |
| ADR на решения | `docs/ADR/` — 5 записей |


---

## Frontend (Phase 3B)

```
Браузер → Next.js (web/) → HTTP API (src/api/) → Application → Domain → PostgreSQL
```

Фронтенд — отдельный workspace `web/` с собственными `tsconfig` и ESLint: корневая
конфигурация рассчитана на Node без DOM, и смешивать их не следует.

**Обращение к API — только server-side.** Браузер работает исключительно со своим
origin, поэтому CORS не нужен (риск R-5 из Phase 3A закрыт), а адрес бэкенда,
`ADMIN_TOKEN` и `LLM_API_KEY` в клиентский пакет не попадают. Изоляция закреплена
импортом `server-only` в API-клиенте: нарушение станет ошибкой сборки.

Подробности — `docs/FRONTEND.md`.

### Точка входа сервиса

`src/app/main.ts` — единая точка запуска: конфигурация → миграции и восстановление
→ сборка конвейера → HTTP-сервер, с корректным завершением по SIGTERM/SIGINT.
До Phase 3B `buildApiRouter` существовал, но не вызывался ниоткуда, и сервис
нельзя было запустить как процесс.


---

## Развёртывание (Phase 4)

```
docker compose up
```

поднимает четыре службы:

| Служба | Роль | Порт |
|---|---|---|
| `postgres` | база данных | 5432 |
| `api` | `APP_ROLE=api` — HTTP, обработку не ведёт | 3001 |
| `worker` | `APP_ROLE=worker` — обработка по расписанию | — |
| `web` | Next.js; обращается к `api` по внутренней сети | 3000 |

Браузер обращается только к `web`; адрес `api` в клиентский пакет не попадает.
Секретов в `docker-compose.yml` нет: значения подставляются из окружения либо
из `.env`, который не хранится в Git.

`api` и `worker` собираются из одного образа и отличаются только `APP_ROLE`:
код и сборка общие, второй проект не заводится.
