# GeoPulse: Technical Architecture

A real-time global **non-financial** risk intelligence platform. This document is the
architecture reference requested against the platform brief — inspired by the broad
category of world-monitoring dashboards, built from GeoPulse's own taxonomy, scoring
logic, schema, and source integrations. No code, UI, scoring logic, or data handling
was copied from any other product; everything described here was designed and
implemented directly against the brief's own requirements.

This is a living document. Where something in the brief isn't built yet, that's stated
plainly rather than glossed over — see the **Gap analysis** at the end. Last brought
back in sync with the actual codebase 2026-09-08 — significant drift had accumulated
(the AI/ML layer, Telegram sourcing, and the correlation/history systems below didn't
exist yet the last time this was fully updated).

## 1. Product model

Every country carries two independent measures, never collapsed into one number:

- **Pulse Level** (1–4: Low/Medium/High/Extreme, categorical) — how much is actively
  happening right now.
- **Momentum** (0–100 + direction) — how fast that's changing.

(Internally these are still named `ThreatLevel`/`threatLabel` throughout the codebase —
a user-facing relabeling only, not a different model. See `src/lib/threat.ts`'s own
header comment.)

Both exist at two levels: **per pillar** (one of eight) and **overall** (rolled up from
pillars via escalation, not averaging). Implemented in `src/lib/threat.ts` and
`src/lib/risk.ts`.

### 1.1 Computation pipeline

```
raw event (GDELT/RSS/Telegram/USGS/EONET/GDACS/IODA/FIRMS)
  → translate if non-English (Telegram only)          src/lib/translate.ts
  → classify (category + severity + country)          src/lib/classify.ts
  → cross-outlet duplicate detection                   src/lib/eventDedup.ts
  → store as "pending"                                 events table
  → Gemini pre-publish review (approve/reject)         src/lib/classifierAudit.ts
  → decay-weight by age (3-day half-life)              src/lib/risk.ts
  → sum into 8 pillars, per country                    src/lib/risk.ts
  → weight → pillar Pulse Level (threshold table)       src/lib/threat.ts
  → recent-vs-prior window → pillar Momentum           src/lib/threat.ts
  → escalate pillars → country Pulse Level              src/lib/threat.ts
  → driver pillar's momentum → country Momentum         src/lib/risk.ts
```

Direct/structural sources (USGS, EONET, GDACS, IODA, FIRMS) skip translation,
classification, and the pre-publish review gate entirely — there's no editorial
judgment call in "a magnitude-6 earthquake happened at these coordinates," so they're
inserted straight to `reviewStatus: "approved"`.

Pulse Level thresholds and the escalation rule (max of pillars, +1 when 2+ pillars are
independently High(3)+, capped at 4) are implemented in `src/lib/threat.ts`. Nothing
here is a "Country Risk Score = 83/100" — a pillar with no wired source shows
**not tracked**, not a fabricated Low.

## 2. Eight pillars

`src/lib/pillars.ts` defines all eight exactly as specified: Geopolitical & Security,
Political & Governance, Climate & Environment, Natural & Biological Hazards, Human &
Social, Infrastructure & Connectivity, Supply Chain & Resource Security, Cyber &
Technology — each with an id, label, description, and accent color used consistently
across the UI. `CATEGORY_PILLAR` is the single source of truth mapping every event
category to exactly one pillar.

| Pillar | Status | Live sources today |
|---|---|---|
| Geopolitical & Security | **Covered** | GDELT (5 flashpoint queries), 35 RSS wires, ~18 Telegram channels |
| Political & Governance | **Covered** | GDELT (coup/election/emergency-rule query), RSS/Telegram keyword classification |
| Climate & Environment | **Covered** | GDACS + NASA EONET (flood/wildfire/drought split out from hazards) |
| Natural & Biological Hazards | **Covered** | USGS (earthquakes), GDACS + EONET (cyclone/volcano/tsunami/severe storm), NASA FIRMS (thermal anomalies, optional key) |
| Human & Social | **Covered** | GDELT (famine/displacement/humanitarian-crisis query), RSS/Telegram |
| Infrastructure & Connectivity | **Covered** | IODA (country-level internet outage detection) |
| Supply Chain & Resource Security | **Not tracked** | none wired — see Gap analysis |
| Cyber & Technology | **Partial** | CISA KEV as a global (non-country-attributed) ticker only |

`COVERED_PILLARS` in `pillars.ts` is the literal boolean gate the UI reads — this table
is generated from that constant, not aspirational.

## 3. Event model

Current schema (`src/db/schema.ts`, one `events` table):

```
id, source, url (unique), title, summary, category, location, country (iso2, nullable),
lat, lon, severity (1–5), published_at, created_at,
correlation_group_id, primary_event_id, review_status
```

`correlation_group_id` (`src/lib/correlation.ts`) is a coarse deterministic
`country:pillar:UTC-day` bucketing key, used to compute a source-diversity confidence
tier ("single-source"/"corroborated"/"cross-confirmed") on the Risk tab.

`primary_event_id` (`src/lib/eventDedup.ts`) is finer-grained: real title/summary
Jaccard-similarity comparison against recent same-country/same-category events. A
non-null value means "this is a same-story report of the primary event with this id" —
hidden from the main feed, surfaced only as an additional source when its primary is
expanded.

`review_status` (`"pending" | "approved" | "rejected"`) gates the pre-publish Gemini
review (see §6). A stale pending row auto-promotes after 30 minutes rather than
staying invisible forever if the review step is unavailable.

This is still deliberately smaller than the brief's full normalized event model
(`event_subtype`, `admin1/admin2`, `confidence`, `fatalities`, `population_exposed`,
`raw_payload_hash`, `geometry`, etc.) — every field that's missing is missing because
nothing downstream consumes it yet, per the brief's own warning (§22) against
premature schema-first design. See the **Gap analysis** for what would earn each
group of fields its place.

## 4. Source registry & licensing

`src/lib/sourceRegistry.ts` is a typed, in-code provider table (not yet a DB table —
see Gap analysis) covering every source currently wired: GDELT, 35 RSS wires, Telegram
(~18 channels, a knowing exception to this registry's normal licensing bar — see
`docs/TELEGRAM_SOURCES.md` for the full reasoning), USGS, NASA EONET, GDACS, IODA,
NASA FIRMS, CISA KEV, Frankfurter/ECB, the community currency CDN, World Bank, CFTC,
OpenSky, adsb.lol, Open-Meteo, Finnhub. Each row records provider, license,
`commercial_use`, `redistribution_allowed`, `attribution_required`, `caching_allowed`,
rate limit, `api_key_required`, and `terms_last_checked` — implemented as TypeScript
types rather than a DB schema for now (no UI currently reads it back; see Gap analysis
for when it should move to Postgres). Every RSS/Telegram outlet is additionally checked
against independent media-bias/reliability trackers before being wired in — see
`docs/SOURCE_CREDIBILITY.md` for the full per-outlet writeup.

**Sources evaluated and explicitly rejected**, with reasons on record (see
`src/lib/sources/README.md` and `docs/SOURCE_CREDIBILITY.md`):

- **ReliefWeb** — v1 decommissioned, v2 requires a registered `appname` (an API key in
  practice). Not integrated; Human & Social coverage comes from GDELT/RSS/Telegram
  keyword classification instead.
- **World Bank Worldwide Governance Indicators** — the brief's suggested indicator
  codes (`CC.EST`, `PV.EST`, etc.) resolve to an *archived* World Bank data source and
  return "not found" on live queries. Not integrated pending a working query path.
- **gpsjam.org** — no documented public endpoint, fetched server-side by their own app
  only.
- Reuters/AP/AFP — the wire services working journalists actually rank as the trust
  benchmark were checked for a usable free RSS feed; none exists today (see
  `docs/SOURCE_CREDIBILITY.md`'s "wire-service gap" section). An honest gap, not
  papered over with a weaker substitute.

## 5. Momentum engine

Implemented horizons: **24h vs. prior 24h**, **7d vs. prior 7d**, blended 60/40 toward
the shorter window. The brief's suggested 1h and 30d horizons are not implemented —
1h needs a source with genuinely sub-hourly cadence to be meaningful, and 30d is a
straightforward SQL addition to the existing `getCountryCategoryRows` query whenever a
consumer needs it (the trend-chart use case in the Gap analysis).

Momentum is **not** baselined against each country's own historical norm yet (the
brief's "100 protests/month is normal for country X" point) — today's recent-vs-prior
comparison is the same shape for every country. `country_state_history` (§6 below) now
exists and accumulates the daily data a future baseline would need, but nothing reads
it that way yet.

## 6. The AI/ML layer

Three live Gemini (`gemini-3.5-flash-lite`) integrations, plus one embeddings model and
one non-generative translation API — all direct REST calls, no SDK:

- **Pre-publish review gate** (`reviewPendingEvents`, `src/lib/classifierAudit.ts`) —
  every classified RSS/GDELT/Telegram item is inserted `reviewStatus: "pending"` and
  invisible to every public read path until Gemini independently re-checks
  inclusion/severity/country, almost always within the same or next ~15min ingest
  cycle. A stale pending row (30+ min, e.g. Gemini unavailable) auto-promotes on the
  classifier's own original verdict rather than hiding real news indefinitely.
- **Post-hoc classifier audit** (`runClassifierAudit`/`runClassifierAuditSlice`, same
  file) — the same review, but re-run against items already live, on a rolling 30-day
  window. Flags `false_positive`/`false_negative`/`severity_mismatch`/
  `country_mismatch` into a `classifier_audit` table; a human (in practice, Claude on
  a recurring monitoring cadence) reviews and approves/rejects/overrides each finding
  before anything changes — this never auto-writes to the live feed or to
  `classify.ts`'s rules directly, by design (see the table's own doc comment in
  `schema.ts` for the manipulation-surface reasoning).
- **Recursive calibration loop** (`classifier_calibration` table, added 2026-09-08) —
  the actual self-improving piece. When a review reveals a *generalizable* pattern
  (not a one-off), the reviewer records a short "lesson" keyed by a stable pattern
  slug. Every subsequent audit prompt (both above) injects the accumulated active
  lessons — live on the very next call, no redeploy required. A lesson that keeps
  getting reinforced (tracked via an `occurrences` counter) is a candidate to graduate
  into the permanent hand-maintained prompt constants
  (`DELIBERATE_EXCLUSIONS`/`SEVERITY_RUBRIC`/`COUNTRY_GUIDANCE`), which never expire.
- **Daily AI country situation briefs** (`src/lib/countryBriefs.ts`) — one Gemini call
  per currently-active country (ranked by score, capped per run), strictly grounded on
  that country's own real recent events.
- **Embeddings** (`gemini-embedding-001`, `src/lib/embeddings.ts`) — every archived
  article gets a 768-dim vector (backfilled a small batch per ingest cycle); the
  "Similar events" feature (`GET /api/events/[id]/similar`) does pgvector cosine
  similarity search over the full historical corpus (`feed_archive`, not just the live
  30-day window).
- **Translation** (`src/lib/translate.ts`) — Google Cloud Translation API v2, NOT an
  LLM. Translates non-English Telegram posts before classification, daily-budget-
  capped to stay inside the monthly free tier.

All of the above are soft no-ops when their respective API key isn't configured — the
app ships and runs without them, they just activate the moment a key is added. See
`.env.example` for the exact list.

The one LLM path that exists in code but is **not live**: `classifyBatch` in
`src/lib/classify.ts` (structured classification via Vercel's AI SDK,
`generateObject`) — requires a Vercel AI Gateway account with billing enabled. The
deterministic `classifyByKeywords` is what's actually classifying every item today.

## 7. Telegram sourcing

~18 public Telegram channels (state media, OSINT trackers, military bloggers),
rotated a few per ingest cycle. This reads public channel web previews in a way
Telegram's own Content Licensing terms don't clearly sanction for an automated
cron — a deliberate, disclosed exception to this project's normal licensing bar, not
an oversight. See `docs/TELEGRAM_SOURCES.md` for the full reasoning, the explicit
decision to proceed anyway, and the per-channel list with each channel's own
disclosed editorial lean (state-linked channels included and framed as such, not
excluded for having one).

## 8. Gap analysis — what's genuinely NOT built yet

In the order they'd actually get built:

1. **Broader event correlation, beyond near-duplicate merging.** `eventDedup.ts`
   collapses same-story reports from different outlets (real title/summary
   similarity), and `correlationGroupId` buckets by country/pillar/day for a
   confidence tier — but true geographic/temporal/semantic clustering of genuinely
   *distinct-but-related* events (e.g. linking a strike to a retaliation days later)
   doesn't exist. Real, substantial, standalone work — design the clustering approach
   before bolting it on incrementally.
2. **Cross-risk cascade model** (brief §9) — no `causes`/`affects`/`depends_on`-style
   relationship schema exists. Needs (1) above as a prerequisite.
3. **Severity × Exposure × Vulnerability model** (brief §6) — Pulse Level today is
   driven purely by decayed event severity. A severity-5 earthquake in an empty region
   scores the same as one hitting a capital. Needs population/infrastructure exposure
   data (WorldPop, port/energy infrastructure) joined against event geometry.
4. **Structural country context** (GDP, trade dependence, governance indicators) —
   World Bank GDP/population/grid-loss, OWID energy mix, IMF PortWatch (chokepoint
   transits), UN Comtrade (top trade partners), FAO Food Price Index, US travel
   advisories, GPS/GNSS jamming, submarine cable exposure, and Open-Meteo air quality are
   all wired as standalone context/ticker layers (`src/lib/dataLayers.ts`, added
   2026-09-08 — see `docs/API_SOURCES.md`), not joined into the risk/exposure model.
   WGI itself is currently unreachable (see §4). WTO, EIA, full FAOSTAT: not started.
5. **Broader source coverage**: Cloudflare Radar, RIPE Atlas/RIPEstat, AISstream,
   sanctions feeds (OFAC/EU/UK/UN), OpenSanctions, X/Twitter (a real structural gap —
   see `docs/ROADMAP.md`). ACLED, UCDP, and FATF's grey/black list were all
   investigated and confirmed blocked (lag, access-approval terms, or bot-detection —
   see `docs/API_SOURCES.md`), not open items needing a decision.
6. **Admin health/observability panel UI** — the data exists
   (`GET /api/admin/health`, `GET /api/admin/ai-usage`,
   `GET /api/admin/translation-usage`), but nothing renders it as a page yet. (Note:
   `country_state_history`'s own data IS already charted — see the Trends tab,
   §9 below — this gap is specifically the ops/source-health side.)
7. **PostGIS** — not adopted. Current geometry is plain `lat`/`lon` doubles with no
   spatial queries anywhere in the codebase. Revisit once (1) needs real geographic
   proximity queries (`ST_DWithin` etc.) rather than naive lat/lon math.
8. **Momentum baselined against a country's own history** — see §5.

## 9. Country/aircraft history snapshots + statistical anomaly detection

Two daily snapshot jobs (see `vercel.ts`):

- `country_state_history` (`src/lib/history.ts`, `GET /api/admin/snapshot`) — every
  country's Pulse Level/Momentum, once/day. Charted live in the frontend's Trends tab
  (`src/components/TrendsPanel.tsx` → `GET /api/history`) with a deterministic,
  computed-from-the-numbers trend summary (`summarizeHistory` — not an LLM answer).
- `GET /api/admin/snapshot-flights` — one route, four pieces of daily write work, all
  piggybacked onto this single cron (2026-09-09; Vercel's Hobby tier caps cron count,
  and every signal here is daily-cadence anyway, so a 5th/6th cron entry would cost
  something for no benefit):
  1. `aircraft_count_history` (`src/lib/flightBaseline.ts`) — per-country tracked
     aircraft counts, both military (original) and commercial (added 2026-09-09,
     distinguished by a `kind` column). Commercial coverage is real but narrow — only
     the 9 fixed hub points `fetchAdsbLolCommercial` samples, see that file's own doc
     comment.
  2. `gps_jamming_history` (`src/lib/gpsJammingHistory.ts`) — per-country daily
     jammed-cell/aircraft counts from `gpsjam.ts`, previously display-only.
  3. The anomaly scan itself (`src/lib/anomalyScan.ts`) — runs a shared z-score engine
     (`src/lib/anomalyBaseline.ts`, extracted from the original aircraft-only
     implementation) across five signals: aircraft military, aircraft commercial (the
     one signal that flags large *drops*, not rises — an airspace closure), GPS
     jamming, and two live-SQL signals with no snapshot table of their own — event
     volume per country and per country×category, queried directly against `events`
     (`src/lib/eventVolumeAnomaly.ts`) using rolling 24h windows relative to scan time
     rather than calendar-day buckets, so a partial "today" is never compared against
     full historical days. Findings persist to `anomaly_findings`, read as "the latest
     scan generation" (`MAX(detectedAt)`, not a time window — see that table's own
     schema comment for why), surfaced via `GET /api/anomalies` as a signal-agnostic
     "N unusual signals" badge on both the Risk tab and the Trends tab. Deliberately a
     count, not a blended composite score — see the Roadmap's design principles.

Every signal here needs each country to individually clear its own 14-sample baseline
before it says anything — snapshots began 2026-09-03/09-04, so this self-activates per
country over the following ~2 weeks rather than flagging anything off noisy early data.

### 9a. Shadow-mode predictive risk model (not user-facing)

`src/lib/riskModel.ts` — a hand-rolled logistic regression (`src/lib/
logisticRegression.ts`; no ML dependency added, package.json has none and this data
scale doesn't warrant one), trained weekly (`.github/workflows/train-risk-model.yml` →
`GET /api/admin/train-risk-model`, not a `vercel.ts` cron entry — see that workflow's
own comment) on a self-supervised label derived from `country_state_history` itself:
did a country's Pulse Level jump 2+ within 14 days of a given snapshot. Backtested on a
time-based (not random) held-out split, and separately shadow-predicts every country
from its latest snapshot each run, graded later once each prediction's own 14-day
window resolves (`src/lib/riskModelGrading.ts`, daily via `/api/admin/snapshot`,
piggybacked onto that route rather than its own cron). This live-graded track record is
the real calibration evidence — stronger than the historical backtest alone, since
these predictions are made before their outcome is knowable.

Nothing from this reaches a user yet. A run is marked `promoted` in `risk_model_runs`
only once its backtest clears a real sample floor and beats the naive majority-class
baseline on both precision and recall — as of this table's current depth (~6 days),
there are zero eligible labeled examples, so training runs, correctly logs "insufficient
data," and waits. That's the intended behavior: visibility is gated on measured
evidence, not a guessed calendar date.

## 10. Backend architecture — what's built, and why it deviates from the brief

**Current**: Next.js App Router, deployed entirely on Vercel (frontend + serverless API
routes), Postgres via Neon, no separate worker service.

The brief recommends *not* relying on Vercel alone for persistent ingestion workers.
That recommendation is correct, and this project hit exactly the failure mode it
warns about: the originally-intended scheduling mechanism (a GitHub Actions cron
calling `/api/ingest`) went **entirely silent for over a week** (added 2026-08-27,
first fired 2026-09-04) before a forced re-registration of its schedule fixed it. It's
now firing reliably and kept as a real backup, alongside:

- **cron-job.org** (the actual primary trigger) — an external scheduler hitting
  `/api/ingest` directly, authenticating via `?secret=` (see `cronAuth.ts`). Its
  schedule lives in cron-job.org's own dashboard, not in this repo. One hard,
  non-configurable constraint shaped `src/lib/ingest.ts` and `src/lib/sources/gdelt.ts`:
  a 30s request timeout.
- **Self-triggering from the live stream** — every new SSE connection
  (`src/app/api/stream/route.ts`) opportunistically kicks off a background ingest run,
  gated to at most once per ~10 minutes per warm instance, via Next's `after()` API.
  "Someone has the site open" is sufficient to keep the feed live.
- **A daily Vercel cron floor** (`vercel.ts`) — Vercel Hobby plan caps custom cron
  frequency at once/day, so this is a floor, not a primary mechanism. `vercel.ts` also
  schedules the four other daily admin jobs: `snapshot`, `snapshot-flights`,
  `generate-briefs`, and `audit-classifier` (all real cron entries, not just ingest).

Moving ingestion to a dedicated always-on worker (Railway/Fly.io/Render, per the
brief) is still the cleaner long-term architecture and stays on the roadmap, but three
independent real-time-ish triggers covering for each other means it's no longer a
single point of failure the way it was before 2026-09-04.

**Serverless duration**: Vercel Hobby-tier functions are commonly documented at a 60s
ceiling; this project's Fluid Compute setting has empirically allowed a full ~60–90s
ingest cycle to complete. `/api/ingest` and `/api/stream` are both written defensively
regardless (short internal timeouts, fast per-source failure, self-closing streams)
rather than assuming a generous budget.

## 11. Deployment

- **Frontend + API routes**: Vercel (Next.js App Router, Node.js runtime).
- **Database**: Neon Postgres (serverless HTTP driver, `@neondatabase/serverless`),
  `pgvector` extension enabled for embeddings.
- **Ingestion trigger**: cron-job.org (primary) + GitHub Actions (backup) +
  self-triggered from the live stream + a daily Vercel cron floor. No dedicated
  worker service exists yet.
- **Migrations**: no framework — `GET /api/admin/migrate` applies the current desired
  schema via idempotent `CREATE`/`ALTER ... IF NOT EXISTS` statements, run by hand
  after a schema change ships (see the route's own doc comment for why).
- **Secrets**: Vercel project environment variables — see `.env.example` for the
  complete, current list (kept in sync by grepping the codebase for every
  `process.env.*` read, not guessed). `DATABASE_URL` is the only hard requirement;
  everything else (Finnhub, FIRMS, Gemini, Google Translate) is a soft-no-op optional
  key.
- **Observability**: `source_health` table + `GET /api/admin/health` (per-source
  last-attempt/last-success/last-error), plus `GET /api/admin/ai-usage` and
  `GET /api/admin/translation-usage` for AI/translation quota visibility. No frontend
  panel renders any of these yet (Gap analysis §6).

Deploying a second, independent worker service (Railway/Fly.io/Render) for real
scheduled ingestion — decoupled from anyone visiting the site — is the top backend
infrastructure item on the roadmap.

## 12. What this document intentionally does not repeat

`docs/ROADMAP.md` carries the phased build order and day-to-day status;
`docs/SOURCE_CREDIBILITY.md` carries the per-outlet bias/reliability vetting for every
RSS/Telegram source; `docs/TELEGRAM_SOURCES.md` and `src/lib/sources/README.md` carry
per-source integration notes and rejected-source reasoning; `src/lib/sourceRegistry.ts`
carries the licensing table itself. This document is the map of how those pieces fit
together.
