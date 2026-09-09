# Открытые вопросы — Metacritic Games Service

**Статус:** все блокирующие вопросы закрыты
**Обновлено:** 2026-09-07

Закрытые вопросы содержат **зафиксированное решение**, обязательное к исполнению и
отражённое в ADR.

---

## Сводка статусов

| ID | Тема | Статус | Решение |
|---|---|---|---|
| OQ-1 | Граница суток | ✅ ЗАКРЫТ | UTC, конфигурируемо |
| OQ-2 | Технологический стек | ✅ ЗАКРЫТ | Модульный монолит, Next.js + Node/TS + PostgreSQL |
| OQ-3 | Developer vs Publisher | ✅ ЗАКРЫТ | Оба поля, без подмены, null + лог |
| OQ-4 | Идентичность игры | ✅ ЗАКРЫТ | UUID внутри, canonical slug + source снаружи |
| OQ-5 | YouTube transcripts | ✅ ЗАКРЫТ | Optional feature, feature flag, graceful degradation |
| OQ-6 | LLM провайдер/модель | ✅ ЗАКРЫТ | Claude Haiku-класса, модель в config, порт `LlmProvider` |
| OQ-7 | Realtime transport | ✅ ЗАКРЫТ | SSE |
| OQ-8 | Auth для Force Run | ✅ ЗАКРЫТ | Статический `X-Admin-Token`, constant-time сравнение |
| OQ-9 | Cold-start seeding | ⚠️ ОТКРЫТ | Рекомендация: seed при первом старте |
| OQ-10 | Обработка изображений | ⚠️ ОТКРЫТ | Рекомендация: hotlink CDN |
| OQ-11 | Объём отзывов | ⚠️ ОТКРЫТ | Рекомендация: первая страница, 30–50 |
| OQ-12 | Алгоритм похожих игр | ⚠️ ОТКРЫТ | Рекомендация: content-based v1 |
| OQ-13 | Семантика «20 игр» | ✅ ЗАКРЫТ | 20 уникальных успешно CLAIMED игр |
| OQ-14 | Повторный обход за день | ⚠️ ОТКРЫТ | Рекомендация: не повторять |
| OQ-15 | Хостинг | ✅ ЗАКРЫТ | Docker Compose на VPS |
| OQ-16 | AI transcript logs | ✅ ЗАКРЫТ | Полная история, raw неизменяемы, merged audit trail |
| OQ-17 | Исторический backfill | ⚠️ ОТКРЫТ | Рекомендация: forward-only |
| OQ-18 | Per-platform scores | ✅ ЗАКРЫТ | **Исследование проведено** — Metascore привязан, Userscore нет |
| OQ-19 | Секреты в raw AI logs | ✅ ЗАКРЫТ | By design + скан перед публикацией + остановка и эскалация |
| OQ-20 | Охват merged audit trail | ✅ ЗАКРЫТ | Только взаимодействия по этому проекту |

Легенда: ✅ закрыт · ⚠️ открыт (безопасный default, не блокирует)

**Блокирующих вопросов не осталось.**

---

# ЗАКРЫТЫЕ ВОПРОСЫ

## ✅ OQ-1 — Граница суток

**РЕШЕНИЕ:** день определяется по **UTC**; timezone конфигурируется через
`PROCESSING_TIMEZONE`, в demo — UTC. Время сервера не используется. См. **ADR-0002**.

---

## ✅ OQ-2 — Технологический стек

**РЕШЕНИЕ:** модульный монолит; Next.js + TypeScript (frontend), Node.js + TypeScript
(backend), PostgreSQL. Без микросервисов. Доменные модули не зависят напрямую от
infrastructure/external providers. См. **ADR-0001**.

---

## ✅ OQ-3 — Developer vs Publisher

**РЕШЕНИЕ:** хранить оба поля раздельно; **никогда** не подменять developer publisher'ом;
при невозможности определить — `null`/`unknown` + запись в ingestion log.

**Подтверждено исследованием** (4 игры): developer доступен в
`data-testid="hero-summary-developer"`; JSON-LD `publisher` смешивает издателя и
разработчика (Elden Ring → Bandai Namco + From Software); есть реальный случай отсутствия
developer (`the-blood-of-dawnwalker`). См. **ADR-0003**.

---

## ✅ OQ-4 — Идентичность игры

**РЕШЕНИЕ:** внутренний PK — **UUID**; внешний ключ — **canonical slug + source**;
title как ключ не используется. Source metadata не смешивается с доменными полями.
См. **ADR-0003**.

---

## ✅ OQ-5 — YouTube transcripts

**РЕШЕНИЕ:** реализуется после обязательной части и мониторинга; управляется feature flag;
отсутствие/ошибка transcript **никогда** не ломает основной pipeline; graceful degradation
обязательна. См. **ADR-0005**.

---

## ✅ OQ-6 — LLM провайдер и модель

**РЕШЕНИЕ:**
- Для MVP — **Claude Haiku-класса**.
- Конкретная модель выносится в configuration/environment.
- Код **не зависит** от конкретной модели.
- Используется порт `LlmProvider`.
- Замена provider/model возможна **без изменения domain/application logic**.
- Для unit/integration тестов создаётся **mock/fake LLM provider**.
- API key — только через environment variable.
- **Никогда** не логировать API key или полный `Authorization` header.

См. **ADR-0006**.

---

## ✅ OQ-7 — Realtime transport

**РЕШЕНИЕ:** SSE — поток односторонний (server→client), автопереподключение, минимум
инфраструктуры.

---

## ✅ OQ-8 — Аутентификация Force Run

**РЕШЕНИЕ:** статический **`X-Admin-Token`** для demo.

Требования:
- токен только в environment variable, **не** в Git;
- **не** публикуется в README в открытом виде;
- `.env.example` содержит только имя переменной и placeholder;
- `POST /api/runs` требует корректный токен;
- обязателен rate limit;
- неверный токен → **401/403**;
- сравнение — **constant-time**;
- сам токен **не логируется**.

Полноценные пользователи / JWT / OAuth на MVP не вводятся. См. **ADR-0007**.

---

## ✅ OQ-13 — Семантика «20 игр»

**РЕШЕНИЕ:** 20 уникальных игр, успешно **CLAIMED** в рамках processing day. Claim
идемпотентен; повторный запуск не создаёт дубль claim; retry/recovery — через lease/reaper
без duplicate claim. См. **ADR-0004**.

---

## ✅ OQ-15 — Deployment

**РЕШЕНИЕ:** Docker Compose на VPS, production-like без избыточной инфраструктуры.

---

## ✅ OQ-16 — AI development history

**РЕШЕНИЕ:** полная история сохраняется; raw logs не редактируются; логи разных агентов —
отдельно; дополнительно merged JSONL audit trail с `timestamp`, `agent`, `role`,
`event type`. См. **DEVELOPMENT_WORKFLOW.md**.

---

## ✅ OQ-18 — Per-platform Metascore и Userscore

**РЕШЕНИЕ:** проведено отдельное исследование до реализации ingestion (требование
Product/Tech Lead). Результат — `docs/METACRITIC_PLATFORM_SCORES.md`.

**Итог:**

| Метрика | Связь с платформой | Решение |
|---|---|---|
| **Metascore** | **Доказана** | `metascore_scope = 'platform'` |
| **Userscore** | Не публикуется по платформам | `userscore_scope = 'overall'` |

Доказательство для Metascore — оценки **различаются** между платформами и находятся в одном
DOM-контейнере с названием платформы:

- `elden-ring`: PC 94, Xbox Series X 96, PlayStation 5 96, PS4/Xbox One `tbd`
- `the-witcher-3-wild-hunt`: PC 93, Xbox One 91, PlayStation 4 92

Userscore публикуется только общий по игре (Elden Ring — 8.4). Вычислять собственное среднее
по платформам и выдавать за оценку Metacritic **запрещено** — это была бы ложная связь.
Схема резервирует `score_scope='derived'` на будущее.

**Следствие для схемы:** `metascore_scope` и `userscore_scope` — **раздельные** поля, так как
достоверность привязки у метрик разная. См. **ADR-0008**.

---

## ✅ OQ-19 — Секреты в raw AI logs

**РЕШЕНИЕ:** raw logs остаются действительно raw.

- Секреты не попадают в raw logs **by design**.
- **Запрещено** автоматически изменять содержимое raw log после записи.
- Перед публикацией выполняется secret scan.
- При обнаружении секрета — **остановить публикацию и сообщить Product/Tech Lead**.
- Ретроспективное маскирование raw conversation **запрещено**.

---

## ✅ OQ-20 — Охват merged audit trail

**РЕШЕНИЕ:** включаются только AI-взаимодействия, относящиеся к **этому проекту**.

Сохраняются: raw logs каждого агента/сессии отдельно; merged `ai-conversation.jsonl`;
метаданные `timestamp`, `agent`, `role`, `event type`. Посторонние диалоги не включаются.

---

## ✅ Общее правило по секретам (обязательное)

Никакие реальные **API keys, passwords, admin tokens, database credentials, cookies,
session tokens** не попадают в: Git, README, тестовые fixtures, screenshots, AI logs,
финальный submission.

Контроль: `.gitignore` для `.env`, secret scan в CI и перед публикацией, обязательный пункт
в Definition of Done. См. **DEFINITION_OF_DONE.md**.

---

# ОСТАЮЩИЕСЯ ОТКРЫТЫЕ ВОПРОСЫ

Ни один не блокирует реализацию: у всех есть безопасный default. Решение требуется только
при несогласии с рекомендацией.

## ⚠️ OQ-9 — Cold-start seeding
**Рекомендация:** один прогон ingestion при первом старте, иначе проверяющий увидит пустой
список (до часа ожидания). Относится к Фазе 7.

## ⚠️ OQ-10 — Обложки: hotlink или собственное хранение
**Рекомендация:** hotlink CDN + lazy loading на MVP. Относится к Фазе 2.

## ⚠️ OQ-11 — Объём отзывов на игру
**Рекомендация:** первая страница, cap 30–50 каждого типа. Относится к Фазе 3.

## ⚠️ OQ-12 — Алгоритм похожих игр
**Рекомендация:** content-based v1 (жанры + платформы + developer/publisher + trigram).
Схема БД уже допускает переход на pgvector без миграции данных (ADR-0009).
Относится к Фазе 4.

## ⚠️ OQ-14 — Повторный обход игры в тот же день
**Рекомендация:** не повторять — буквальное прочтение ТЗ. Относится к Фазе 1.

## ⚠️ OQ-17 — Исторический backfill
**Рекомендация:** forward-only; наполнение БД перед демо через Force Run.
Относится к Фазе 7.

---

## Вопросы, требующие ответа перед деплоем (Фаза 7)

1. Доступ к VPS и домену.
2. API-ключ OpenRouter для продакшн-стенда (OQ-6).
3. Подтверждение открытых вопросов Фаз 2–4, если не согласны с рекомендациями.
