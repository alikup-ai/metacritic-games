# Technical Discovery — Metacritic Games Service

**Status:** draft for Product/Tech Lead review
**Date:** 2026-09-07
**Author:** Lead Software Engineer / Solution Architect

> Statements marked **[VERIFIED]** were confirmed by live probing of Metacritic on
> 2026-09-07 (raw HTTP, no browser). Statements marked **[ASSUMPTION]** are design
> decisions needing your sign-off. Open items are tracked in `OPEN_QUESTIONS.md`.

---

## 0. Ground truth established during discovery

Before designing anything I probed the real endpoints, because the biggest cost driver in
this project is *"do we need a headless browser or not"*. The answer is **no**, and that
changes the whole architecture.

| Probe | Result |
|---|---|
| `GET /game/` (plain curl + normal UA) | **200**, 969 KB, ~1.1 s — no JS challenge **[VERIFIED]** |
| `GET /browse/game/all/all/all-time/new/` | **200**, 342 KB, ~0.7 s **[VERIFIED]** |
| `__NEXT_DATA__` blob present | **No** — content is server-rendered HTML **[VERIFIED]** |
| JSON-LD on detail page | **Yes**: `VideoGame`, `AggregateRating`, `VideoObject`, `ImageObject`, `Organization` **[VERIFIED]** |
| Critic reviews `/game/<slug>/critic-reviews/` | **200**, review text + per-critic scores in raw HTML **[VERIFIED]** |
| User reviews `/game/<slug>/user-reviews/` | **200**, same shape **[VERIFIED]** |
| `robots.txt` | Blocks named bots (GPTBot, CCBot, AhrefsBot...). **No `Disallow` on `/browse/` or `/game/`** for a generic UA. Publishes `games.xml` sitemap **[VERIFIED]** |

**Consequence:** the entire ingestion pipeline is plain HTTP + HTML parsing. No Playwright,
no browser pool, no per-page RAM budget. This removes the dominant infrastructure cost and
the most common source of flakiness in scraping projects.

### The JSON-LD payload (real sample, `halloween-the-game`)

```json
{
  "@type": "VideoGame",
  "name": "Halloween: The Game",
  "datePublished": "2026-09-08",
  "description": "It is Halloween night, 1978, ...",
  "image": "https://www.metacritic.com/a/img/resize/.../7-1776805800.jpg",
  "genre": "Survival",
  "gamePlatform": ["PlayStation 5", "Xbox Series X", "PC"],
  "publisher": [{"@type": "Organization", "name": "Gun Interactive"}],
  "trailer": {"@type": "VideoObject"},
  "aggregateRating": {"@type": "AggregateRating", "name": "Metascore"}
}
```

This one block covers **title, description, cover image, platforms, publisher, and trailer
link** — 6 of the 7 required fields, from a schema.org contract far more stable than CSS
classes. **Design rule: JSON-LD is the primary extractor; CSS selectors are the documented
fallback.** This is the main defence against Metacritic redesigns.

> **Note:** the field is `publisher`, **not** developer. The task asks for *Разработчик*
> (developer). These are genuinely different entities and JSON-LD gives us the publisher.
> See **OQ-3**.

---

## 1. Functional requirements

### 1.1 Mandatory (from the brief)

| # | Requirement | Notes |
|---|---|---|
| FR-1 | Hourly job ingests **20 games not yet processed today** | "20" = per-run batch size |
| FR-2 | First run of a day → New Releases from `/game/` | Source A |
| FR-3 | Subsequent runs → `/browse/.../new/`, next page each time | Source B |
| FR-4 | Each new day the cycle restarts from Source A | Day = calendar day in fixed TZ (**OQ-1**) |
| FR-5 | Existing game is **updated**, not duplicated | Upsert on stable key |
| FR-6 | Capture title, cover, platform+Metascore+Userscore (N platforms), developer, description, video link | Platform data is 1..N per game |
| FR-7 | Separate LLM summaries for **critic** and **user** reviews (likes / dislikes) | Refreshable on re-crawl |
| FR-8 | Web UI: list, detail card, platform filter, title search, sort by rating | |
| FR-9 | Similar games from **our own DB**, clickable through to their card | |

### 1.2 Optional part 1 — YouTube let's-plays
Find let's-plays, take the **most popular**, transcribe the narration, derive a conclusion,
attach it to the game with a link to the video.

### 1.3 Optional part 2 — Realtime monitoring
Live worker status, processed counters, and a **force-run button**.

### 1.4 Deliverables
Repository link, a **live running service**, and full raw JSONL AI transcripts. The "live
service" requirement makes deployability a first-class constraint, not an afterthought — it
is weighted in every technology choice below.

### 1.5 Derived requirements (implied — flagged, not silently invented)

- **DR-1** Per-platform scores imply a `game_platform` child table, not columns on `game`.
- **DR-2** "Not processed today" implies a persisted per-day ledger surviving restarts.
- **DR-3** "Next page each run" implies a persisted per-day cursor.
- **DR-4** Summaries "may be updated" implies storing a content fingerprint to avoid paying
  an LLM call when reviews have not changed.
- **DR-5** The service must show useful data within minutes of a cold deploy, or a reviewer
  opening the link sees an empty list. Drives seed-on-first-boot (**OQ-9**).

---

## 2. Non-functional requirements

| Area | Target | Rationale |
|---|---|---|
| Availability | Best-effort single node; survives restart with zero data loss | Demo service, not a bank |
| Politeness | ≤ 1 req/s to Metacritic, 1 concurrent connection, backoff on 429/5xx | Avoids IP ban that would kill the demo |
| Batch latency | 20 games ≤ 10 min wall clock | Must finish well inside the 1 h window |
| UI latency | list p95 < 300 ms, detail p95 < 400 ms | Indexed queries, no N+1 |
| Durability | All progress in Postgres; process is stateless | Restart-safety requirement |
| Cost | ≤ ~$5–10 for the evaluation period | See §18 |
| Observability | Every run auditable after the fact | Required to *prove* correctness to the reviewer |
| Reproducibility | `docker compose up` → working service | Evaluator convenience |

---

## 3. User flows

**U1 — Evaluator opens the service.** Lands on list, sees populated data immediately
(seeded), can search/filter/sort without reading docs.

**U2 — Browse & filter.** Filter by platform, search by title (debounced), sort by
Metascore/Userscore/date. Filters live in URL query params → shareable, back-button correct.

**U3 — Game card.** Cover, description, developer, per-platform score table, trailer embed,
critic summary, user summary, YouTube conclusion, similar games.

**U4 — Similar-game traversal.** Click a similar game → its card. Enables the "browse
around" behaviour an evaluator uses to judge data quality.

**U5 — Monitoring.** Live dashboard: run state, worker states, counters, per-item progress,
errors, day-cursor position.

**U6 — Force run.** Click → immediate run. Must be safe when a run is already in flight: UI
disables the button and reports "already running" rather than double-processing.

**U7 — Cold-start recovery (operator).** After a crash the service resumes without manual
intervention and the dashboard explains what happened.

---

## 4. Backend components

Single deployable Node.js/TypeScript app (**OQ-2**) with internal module boundaries:

- **HTTP API** — REST for the UI (`/api/games`, `/api/games/:slug`, `/api/platforms`,
  `/api/runs`, `/api/status`, `POST /api/runs`).
- **Realtime gateway** — SSE stream of run/worker events (§11).
- **Scheduler** — in-process cron with DB lock (§7).
- **Orchestrator** — decides *what* the batch is (day-plan logic, CORE section).
- **Fetcher** — polite HTTP client: UA, rate limit, retry, conditional GET, caching.
- **Parsers** — `listParser` (both sources), `gameParser` (JSON-LD first), `reviewParser`.
- **Enrichment services** — LLM summarizer, similarity, YouTube.
- **Repositories** — all SQL; the only layer touching the DB.
- **AI transcript logger** — appends every LLM/API exchange to JSONL (deliverable §1.4).

Rationale for a modular monolith over microservices: the workload is tiny, the deliverable
must be trivially runnable, and distributed tracing across services would cost more than it
teaches here. Boundaries stay clean so extraction remains possible.

---

## 5. Frontend components

- `GameList` — card grid, pagination/infinite scroll, skeletons.
- `FilterBar` — platform multi-select, debounced search, sort dropdown; state in URL.
- `GameCard` (detail) — hero, `PlatformScoreTable`, `TrailerEmbed`, `ReviewSummary` ×2
  (visually distinct critic vs user), `YouTubeConclusion`, `SimilarGames`.
- `MonitoringDashboard` — `RunStatusPanel`, `WorkerGrid`, `CounterTiles`, `EventLog`,
  `ForceRunButton`, `DayPlanIndicator` (shows Source A/B and page cursor).
- Empty/error/loading states throughout — an evaluator *will* hit them.

**[ASSUMPTION]** SSR framework (Next.js) for fast first paint and simple deployment; the UI
is read-mostly so this is low-risk. See **OQ-2**.

---

## 6. Background workers

Pipeline stages per game, each independently retryable and independently persisted:

1. **discover** — resolve the batch (list pages → slugs).
2. **fetchGame** — detail page → JSON-LD → core fields + platforms.
3. **fetchReviews** — critic + user review pages.
4. **summarize** — 2 LLM calls (skipped if review fingerprint unchanged — DR-4).
5. **similar** — compute neighbours.
6. **youtube** — search → pick top → transcript → conclusion.

**Key design decision — staged persistence.** Each stage commits its own result as it
completes, and each game carries a per-stage status. A crash after stage 2 does **not**
discard stages 1–2 on retry; the item resumes at stage 3. This is what makes "partially
completed processing" safe (§14).

**Failure isolation:** stages 4–6 are *enrichment*. Their failure must never prevent the
game being saved and displayed — the game is `complete_core` with `summary_status=failed`.
Only stages 1–3 can fail an item outright.

Concurrency: a small worker pool (default 4) over *items*, but the Metacritic fetcher is
globally rate-limited so politeness holds regardless of pool size (§15).

---

## 7. Scheduler

Hourly trigger. Every run — scheduled or forced — goes through **one** code path:
`startRun(trigger: 'cron' | 'manual')`.

**[ASSUMPTION]** In-process scheduler (`node-cron`) + Postgres advisory lock, rather than an
external scheduler. Justification: single-node deployment, and the lock is required anyway
for the force-run button. Migration path to a real queue noted in **OQ-2**.

Correctness rules:
- Acquire `pg_try_advisory_lock` before starting; if not acquired, exit as `skipped`.
- Lock is session-scoped → **released automatically by Postgres if the process dies**. This
  is the primary defence against a crashed run wedging the scheduler forever.
- Missed ticks (process down) are **not** back-filled; the next tick just runs. The day-plan
  makes catch-up naturally correct because it derives from DB state, not tick counting.

---

## 8. Database

**PostgreSQL** — chosen for transactional upserts, `ON CONFLICT`, advisory locks, `pg_trgm`
fuzzy title search, and JSONB. All of these are actually used here. SQLite would fail the
concurrency and search requirements.

### Core schema (abridged)

```
game
  id, slug UNIQUE, title, description, cover_url, trailer_url,
  developer, publisher, genres[], release_date,
  metascore_overall, userscore_overall,     -- denormalised for sorting
  content_hash, first_seen_at, last_updated_at

game_platform            -- DR-1: 1..N per game
  game_id, platform_slug, platform_name, metascore, userscore,
  critic_count, user_count
  PRIMARY KEY (game_id, platform_slug)

review_snapshot
  game_id, kind ENUM('critic','user'), raw_reviews JSONB,
  reviews_fingerprint, fetched_at

review_summary
  game_id, kind, likes TEXT, dislikes TEXT, verdict TEXT,
  source_fingerprint, model, token_usage, generated_at
  UNIQUE (game_id, kind)

youtube_insight
  game_id, video_id, video_url, title, channel, view_count,
  transcript_source, conclusion, generated_at

similar_game
  game_id, similar_game_id, score, method, computed_at
  PRIMARY KEY (game_id, similar_game_id)

-- Scheduling / idempotency core
processing_day           -- one row per calendar day
  day DATE PRIMARY KEY, phase ENUM('new_releases','browse','exhausted'),
  browse_page INT, new_releases_done BOOL

daily_processed_game     -- THE "not processed today" ledger (DR-2)
  day DATE, game_slug TEXT, run_id, status, stages JSONB, updated_at
  PRIMARY KEY (day, game_slug)

run
  id, trigger, status, started_at, finished_at,
  planned_count, processed_count, failed_count, skipped_count, error

run_event                -- append-only audit + realtime feed
  id, run_id, ts, level, stage, game_slug, message, payload JSONB
```

`daily_processed_game` with PK `(day, game_slug)` is the linchpin: simultaneously the
ledger, the idempotency guard, and the concurrency guard (§14, §15).

Indexes: `game(metascore_overall DESC)`, `game(release_date DESC)`,
`game USING gin(title gin_trgm_ops)`, `game_platform(platform_slug)`,
`run_event(run_id, ts DESC)`.

---

## 9. External integrations

| Service | Use | Auth | Risk |
|---|---|---|---|
| Metacritic | Listings, detail, reviews | none | Layout change / IP block — **High** |
| LLM provider | Summaries, conclusion | API key | Cost, latency — Low |
| YouTube Data API v3 | Let's-play search | API key | 10 000 u/day quota; search = 100 u → ~100 searches/day — **Medium** |
| Transcript source | Narration → text | varies | **Highest technical risk** — see deep dive |
| Image CDN | Covers | none | Hotlink/referrer policy — Low |

---

## 10. LLM / AI components

**Three distinct jobs**, deliberately separated:

1. **Critic summary** — input: critic reviews. Output: `likes`, `dislikes`, `verdict`.
2. **User summary** — input: user reviews. Same shape, different voice/prompt.
3. **YouTube conclusion** — input: transcript. Output: a short conclusion.

Design rules:
- **Structured output** (JSON schema / tool-use) — never free-text parsing.
- **Input budget:** cap at N reviews and M chars each, sampled across the score range (not
  just the top) so the summary reflects the real spread of opinion. Truncation is recorded
  so the summary is honest about its basis.
- **Fingerprint gate (DR-4):** hash the review set; skip the call if unchanged. Single
  biggest cost lever — steady-state re-crawls become nearly free.
- **Grounding:** prompt forbids inventing facts absent from the supplied reviews.
- **Zero-review case:** do **not** call the LLM; store an explicit "not enough reviews"
  state. Many brand-new indie games on the "new" listing have no reviews at all — this is
  the common case, not an edge case.
- **Full JSONL transcript logging** of every request/response — a required deliverable.

**Model choice [ASSUMPTION]:** a small/cheap model (Haiku-class) suffices for summarising
supplied text; this is not a reasoning-heavy task. See **OQ-6**.

---

## 11. Monitoring (optional part 2)

- **Transport [ASSUMPTION]:** **SSE**, not WebSockets. Data flows server→client only; SSE
  auto-reconnects, traverses proxies cleanly, and is far less code. See **OQ-7**.
- **Event bus:** stages emit events → persisted to `run_event` → broadcast to subscribers.
  Persisting *before* broadcasting means a client connecting mid-run can replay recent
  history rather than see an empty screen.
- **Dashboard:** current run + trigger, per-worker state (idle/fetching/summarising +
  current slug), counters, today's plan (phase, page cursor, processed-today count), rolling
  event log, last error.
- **Force-run button** → `POST /api/runs`; returns `202` with run id, or `409` if a run holds
  the lock. UI reflects both outcomes distinctly.
- Plus `/healthz` and `/readyz` for the host platform.

---

## 12. Error handling

Explicit taxonomy, because the correct reaction differs per class:

| Class | Example | Reaction |
|---|---|---|
| Transient network | timeout, ECONNRESET, 5xx | Retry w/ backoff |
| Rate limit | 429 | Retry, honour `Retry-After`, slow global limiter |
| Blocked | 403 challenge | **Abort run**, mark `blocked` — retrying makes it worse |
| Parse failure | JSON-LD absent & selectors miss | Fail item, save raw HTML sample, continue run |
| Partial data | no reviews / no trailer | **Not an error** — nullable field |
| LLM failure | timeout, refusal, bad JSON | Retry once, then mark summary failed; game still saved |
| Quota exhausted | YouTube 403 quota | Disable that stage for the day, continue |
| DB error | constraint violation | Fail item, log, continue |

**Guiding principle: one bad game must never fail the batch.** Item errors are caught at
item scope; only infrastructure errors (DB down, blocked) abort a run.

---

## 13. Retry strategy

- HTTP: 3 attempts, exponential backoff + jitter (1 s → 2 s → 4 s), retry only idempotent
  GETs and only transient/429 classes.
- LLM: 2 attempts; malformed structured output counts as retryable once.
- Item-level: a failed item is **not** retried inside the same run (avoids head-of-line
  blocking). It stays unmarked in the day-ledger and is naturally re-attempted by the next
  hourly run — the schedule itself is the retry mechanism.
- Circuit breaker: N consecutive Metacritic failures → abort run early, record reason.
  Prevents burning an hour hammering a site that is blocking us.

---

## 14. Idempotency & crash-safety

This is the heart of the brief, so it is specified precisely.

**Two-phase claim/complete against `daily_processed_game`:**

1. **Claim:** `INSERT ... ON CONFLICT (day, game_slug) DO NOTHING RETURNING *`.
   Row returned → this worker owns the item. Nothing returned → someone else owns it, skip.
   The claim is atomic, so it doubles as the concurrency guard.
2. **Process** stages, persisting each stage's output as it completes.
3. **Complete:** update the row to `done` with stage detail.

**Recovery from every failure mode in the brief:**

| Scenario | Guarantee | Mechanism |
|---|---|---|
| **App restart** | No duplicates, no loss | All state in Postgres; advisory lock auto-released on disconnect; next tick recomputes the plan from DB |
| **Worker crash** | Item retried, others unaffected | Item left `claimed`; a **stale-claim reaper** (claimed older than lease T) resets it to pending |
| **Job re-run** | Safe | Ledger claim rejects already-done slugs; `ON CONFLICT` upserts make game writes idempotent |
| **Parallel workers** | No double-processing | Atomic claim (row-level); only one wins each slug |
| **Partial processing** | Resumes, does not restart | Per-stage status + stage-level persistence; completed stages skipped on retry |

**Upsert key [ASSUMPTION]:** the Metacritic **slug** — stable, unique, present in every URL.
Titles are not unique (remakes/re-releases). See **OQ-4**.

The **stale-claim lease** is the subtle one: without it, a worker that dies mid-item leaves
that slug claimed forever and it silently never gets processed that day. The reaper closes
this hole.

---

## 15. Concurrency

Three independent levels, deliberately decoupled:

- **Run level:** at most one run globally — Postgres advisory lock. Protects against
  cron + force-run collision and against two app instances.
- **Item level:** worker pool (default 4) pulling claimed items. Safe because claiming is
  atomic.
- **Network level:** a **global token-bucket limiter shared by all workers**, ≤ 1 req/s to
  Metacritic. Critically, politeness is decoupled from pool size — raising concurrency never
  raises request rate against Metacritic. LLM/YouTube have separate limits.

Ordering: the brief implies sequential source order (A then B). The *plan* is ordered;
execution within a batch may be parallel — preserving required semantics without serialising
I/O.

---

## 16. Security

- Secrets via environment only; never committed. `.env.example` documents required keys.
- **Force-run endpoint must be protected** — it is an unauthenticated compute/cost trigger on
  a public URL. Recommend a shared-secret header or basic auth on write endpoints. **OQ-8**.
- Rate-limit write endpoints; strict input validation (zod) on all query params.
- SQL injection: parameterised queries only.
- XSS: scraped and LLM text is untrusted → escape on render; never `dangerouslySetInnerHTML`.
  Sanitise/allowlist embedded video URLs (known YouTube/Metacritic hosts only).
- SSRF: only fetch allowlisted hosts.
- No PII stored; user reviews are public content. Respect robots.txt and identify the bot
  honestly in the UA.

---

## 17. Performance

- Batch: 20 games × ~3 requests ≈ 60 requests at 1 req/s ≈ 1–2 min network-bound, plus LLM
  time (parallel, capped) → comfortably inside 10 min.
- Conditional GET (ETag/Last-Modified) on re-crawled pages saves bandwidth and time.
- UI: server-side pagination, indexed sorts, trigram index for search, aggregates
  denormalised onto `game` to avoid per-row joins in the list view.
- Images: hotlink Metacritic CDN with lazy loading (**OQ-10** covers the alternative).
- Similarity computed on write, cached in `similar_game` — never computed per page view.

---

## 18. Cost

| Item | Estimate |
|---|---|
| LLM summaries | 2 calls/game; cheap model; fingerprint gate makes re-crawls ~free → **low single-digit $** |
| YouTube API | Free tier; ~100 searches/day ceiling is the real constraint |
| Transcripts | Free if captions used; **paid ASR is the cost risk** (**OQ-5**) |
| Hosting | Small VPS / free-tier PaaS + managed Postgres ≈ **$0–7/mo** |
| **Total** | **≈ $5–10 for the evaluation period** |

Main cost lever is the fingerprint gate; second is ASR avoidance.

---

## CORE: Game processing logic (the central requirement)

### Day plan

`processing_day` holds, per calendar day: `phase`, `browse_page`, `new_releases_done`.

```
resolveBatch(day, N=20):
  ensure processing_day row for `day` (INSERT ON CONFLICT DO NOTHING)

  if phase == 'new_releases':
      candidates = first 20 slugs from /game/   (New Releases)
      claimed    = claim(candidates)            -- skips already-done-today
      if claimed < N: top up from browse pages (advance cursor)
      when the New Releases set is fully processed today -> phase = 'browse'

  if phase == 'browse':
      loop:
        page        = browse_page
        candidates  = slugs from /browse/.../new/?page=page
        claimed    += claim(candidates)
        browse_page = page + 1                  -- persisted immediately
        until claimed == N or page limit hit
```

Because the batch derives from **DB state**, not run counters, it is automatically correct
after restarts, missed ticks, and manual runs.

### Daily reset

New calendar day → no `processing_day` row → created with `phase='new_releases'`,
`browse_page=1`. The cycle restarts naturally. **[ASSUMPTION]** the boundary is a fixed
configured timezone (not server-local) so behaviour is deterministic — **OQ-1**.

### VERIFIED RISK — the "next page" cursor is not stable

**[VERIFIED, corrected 2026-09-07]** The initial measurement reported "17 of 33 shared
links" between pages 1 and 2. **That was a measurement error:** it counted every
`/game/<slug>/` link, including the promo blocks in the page header, which are identical on
every page.

Re-checking only the actual list cards (`data-testid="product-title"`) found **0 overlap**
between pages 1/2, 2/3 and 1/3 (20, 17 and 21 cards respectively). Pagination does not
duplicate entries within a single snapshot.

**Why the decision stands.** The listing is sorted by release date descending and includes
future dates (`Sep 7, 2026` and `Sep 8, 2026` appeared on page 1). New games are inserted at
the top continuously, so between two runs an hour apart the set shifts: a game on page 1 can
move to page 2, and entries in between can be skipped. There is no overlap within a snapshot,
but the **drift over time remains**.

**Mitigation (recommended):** treat the page cursor as a *hint*, not a source of truth. The
ledger (`daily_claims`) is authoritative — already-claimed slugs are filtered out, and the
fetcher keeps advancing pages until it has collected N genuinely-new slugs. This protects
against both repeats and skips regardless of pagination behaviour.

### Update vs insert

`INSERT ... ON CONFLICT (slug) DO UPDATE` on `game`; child rows (`game_platform`) reconciled
per run. `first_seen_at` preserved, `last_updated_at` bumped. Enrichment tables keyed to
allow refresh (FR-7).

---

## Deep dives

### Scraping Metacritic
Two list shapes + detail + 2 review pages. **JSON-LD first, CSS fallback**, with a parser
version recorded per game so stale extractions are identifiable after a site change. Persist
a raw HTML sample on parse failure for offline debugging. Golden-file parser tests (committed
HTML fixtures) so a Metacritic redesign is caught by CI rather than by silent data loss.
Honest UA identifying the bot.

### Reviews
Both endpoints are server-rendered **[VERIFIED]** — 10 critic blocks with scores and full
quote text were extracted from `elden-ring/critic-reviews/` over plain HTTP. Capture score,
outlet/author, date, text. **Zero reviews is the normal case for brand-new indie games** —
the pipeline must treat it as valid, not as failure. Review pagination capped at the first
page(s) (**OQ-11**).

### LLM summarization
See §10. Structured output, input sampled across the score spectrum, fingerprint-gated,
grounded prompt, JSONL-logged.

### Similar games
**[ASSUMPTION]** Start with cheap, explainable content similarity: shared genres + platform
overlap + developer/publisher match + title trigram, weighted. Deterministic, zero marginal
cost, no embedding infrastructure, easy to justify in review. Embeddings are the upgrade path
(**OQ-12**). Must exclude self, require a minimum score (better to show 2 good matches than 6
poor ones), and recompute as the corpus grows — early games have few candidates because the
DB is small.

### YouTube integration
Search `"<title> let's play|gameplay"` → rank by view count → transcript → conclusion.
**The transcript step is the highest technical risk in the optional scope:** many gaming
videos have no human captions, auto-captions are often unavailable through official APIs, and
third-party scrapers are fragile and ToS-grey, while ASR costs money and time.
Recommendation: attempt captions; if unavailable, **degrade gracefully** to a
metadata/description-based conclusion clearly labelled as such, rather than failing.
See **OQ-5**.

### Realtime monitoring
See §11. SSE, persist-then-broadcast, replayable recent history.

---

## Recommended MVP scope

| Phase | Content |
|---|---|
| **0 — skeleton** | Repo, Docker Compose, migrations, health checks, CI |
| **1 — mandatory core** | Fetcher, parsers, day plan + ledger, upserts, hourly cron |
| **2 — mandatory UI** | List, detail, filter, search, sort |
| **3 — AI** | Review summaries (critic + user), JSONL logging |
| **4 — similar games** | Content-based |
| **5 — optional 2** | Monitoring + force run *(cheap, highly visible)* |
| **6 — optional 1** | YouTube *(most expensive, riskiest — behind a flag)* |

Phases 1–4 satisfy the mandatory brief completely. Phase 5 is deliberately sequenced before
Phase 6 because it is lower-risk, lower-cost, and far more visible to an evaluator per hour
invested.
