# GeoPulse: Technical Architecture

Latest operational audit: [2026-09-24 budget and explainability audit](AUDIT-2026-09-24.md).
This records the atomic attempt-reservation guards, unchanged scoring-v3
arithmetic, country-panel weighted loads and freshness metadata, production
measurements, and remaining evaluation/coverage gaps. Older sections below
retain historical descriptions; use the dated updates when they conflict.

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

`docs/API_SOURCES.md` is the provider table covering every source currently wired:
GDELT, 35 RSS wires, Telegram (~18 channels, a knowing exception to the normal
licensing bar — see `docs/TELEGRAM_SOURCES.md` for the full reasoning), USGS, NASA
EONET, GDACS, IODA, NASA FIRMS, CISA KEV, Frankfurter/ECB, the community currency CDN,
World Bank, CFTC, OpenSky, adsb.lol, Open-Meteo, Finnhub. Each row records provider,
license, commercial use, redistribution allowed, attribution required, caching
allowed, rate limit, API key required, and terms last checked — tracked in
documentation rather than code or a DB schema for now (no UI currently reads it back;
see Gap analysis for when it should move to Postgres). Every RSS/Telegram outlet is
additionally checked against independent media-bias/reliability trackers before being
wired in — see `docs/SOURCE_CREDIBILITY.md` for the full per-outlet writeup.

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
- **Recursive calibration loop** (`classifier_calibration` table, added 2026-09-08,
  made fully autonomous 2026-09-10) — the actual self-improving piece, and the one
  that no longer needs a human to turn. Every audit call (both above) may now propose
  a `pattern`+`lesson` directly on any finding it flags — but a single Gemini proposal
  is never trusted straight into the live prompt: it's staged as one row of
  `classifier_calibration_evidence` (see that table's own doc comment in `schema.ts`)
  and only promoted once the same pattern slug has been **independently corroborated
  across multiple distinct sources and articles, spread over a minimum time span**
  (`maybeAutoPromote`'s `AUTO_PROMOTE_*` constants in `classifierAudit.ts`) — a bar a
  single article (however cleverly it tries to prompt-inject the auditor) cannot clear
  by itself, so no human review is required for the loop to run. A human/Claude
  reviewer can still shortcut this immediately via `reviewAuditFinding`'s `lesson`
  param, but it's now optional, not load-bearing. Once promoted, every subsequent
  audit prompt injects the accumulated active lessons — live on the very next call, no
  redeploy required. `GET /api/admin/classifier-audit/calibration?pending=1` shows
  what's still accumulating evidence but hasn't cleared the bar yet. A lesson that
  keeps getting reinforced (tracked via an `occurrences` counter) is still a candidate
  for a human to eventually graduate into the permanent hand-maintained prompt
  constants (`DELIBERATE_EXCLUSIONS`/`SEVERITY_RUBRIC`/`COUNTRY_GUIDANCE`), which never
  expire — that graduation step is the one piece of this that's still manual, since it
  means editing and redeploying code, not just writing a database row.

- **Structural sources are not embedded (2026-09-20)** — usgs/eonet/gdacs/ioda/firms
  rows are templated text, so every row of a source embeds to nearly the same vector:
  "similar events" for a FIRMS cluster returned other FIRMS clusters, clustering got a
  meaningless blob, novelty could never fire, and it cost 13% of the embedding budget.
  `structuralSources.ts` lists them; the backfill, clustering corpus and novelty scorer
  all skip them, and `similarEvents.ts` gives them a structured "related" lookup
  instead (news within ±48h that is either inside a ~3° box of the coordinates or same
  country + a hazard-family category).

- **Loop hardening (2026-09-20)** — the corroboration bar proves a lesson is
  *recurring*; it says nothing about whether it's *right*. Ten days of production data
  showed both failure modes: (a) the loop auto-promoted "exclude Gaza/West Bank
  regardless of topic" — Gemini's over-generalisation of a rule the prompt scopes to
  `telegram:presstv` only — three times under three slugs, and the pre-publish gate
  then rejected 96% of non-presstv Gaza/West Bank items for four days; (b) slug entropy
  (908 evidence rows across 725 distinct slugs) meant real recurring rules could never
  clear the bar while accidental near-duplicates did. Five changes, all in
  `classifierAudit.ts`:
  1. **Canonical patterns** (`classifier_calibration_patterns`): the prompt lists the
     known slugs for reuse; a new slug's lesson text is embedded and merged into the
     nearest existing pattern at cosine ≥ 0.92 (threshold chosen from a live
     similarity matrix of real lessons — duplicates ≥ 0.918, distinct rules ≤ 0.902).
  2. **Drift guard**: before anything auto-promotes, one Gemini call with *only* the
     foundational rules classifies the candidate as `restates | narrows | widens |
     contradicts | new`. Only `narrows`/`new` promote; `restates` is discarded (prompt
     bloat); `widens`/`contradicts` are held with the verdict visible at
     `…/calibration?pending=1` and never re-asked. Lessons are now worded as
     *subordinate* to the foundational rules in the prompt, not "authoritative".
  3. **Reinforcement works** (`occurrences` increments on active lessons; inactive ones
     stay dead), **severity auto-applies only at a gap ≥ 2** (finding still created at
     1), **false-positive apply is a soft `rejected`** (never `DELETE`), and a
     **decision memory** refuses to auto-apply a finding that contradicts an
     already-applied one on the same row — a human is the only thing that reverses.
  4. **Hygiene**: the kept-audit only re-audits `approved` rows (gate-rejected rows
     were being re-audited and "deleted" again — a large share of the 985 stale
     findings); pending findings expire at 30 days.
  5. **A ground-truth channel** (`gateReview.ts`, `/admin/gate-review`): every day 10
     of the gate's decisions (5 approve / 5 reject) are sampled with the gate's stored
     reasoning; a person grades them in a minute. Grades flip the live decision when
     the gate was wrong, give a running gate precision/recall, and form the held-out
     evaluation set the shadow k-NN classifier must **beat the live gate on** (≥ 50
     graded rows) before it can ever be promoted. This is the only feedback in the
     system that isn't Gemini judging Gemini.
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

`src/lib/riskModel.ts` — redesigned 2026-09-09 (same day as first shipped) from a
binary escalation classifier to **multi-horizon score regression**: a hand-rolled
linear regression (`src/lib/linearRegression.ts`; no ML dependency, same reasoning as
every other from-scratch statistical piece in this app) predicting a country's actual
future decayed-weight `score` at `PREDICTION_HORIZONS_DAYS = [1, 2, 3, 5, 7, 10, 14]`
days out — a trajectory, not a single yes/no flag. Predicted Pulse Level is *derived*
from predicted score via `threat.ts`'s `weightToThreatLevel()`, the exact function
`risk.ts` already uses everywhere else, so a predicted level is always consistent with
how the app defines Pulse Level rather than a second, independent notion of it. Each
horizon is trained, backtested, and promoted **independently** (its own row in
`risk_model_runs`) — a 3-day forecast can earn trust well before a 14-day one does.

Training data is deliberately bounded two ways: a hard cutoff (`TRAINING_DATA_START`,
2026-09-09) discards the app's launch week outright — live-verified during the first
build attempt, Russia's threatLevel went 2→4 between its literal first two daily
snapshots, the score still climbing from an artificial "no history yet" cold start, not
a real escalation — and a **per-country** burn-in on top (7 days past each country's own
first post-cutoff snapshot), since that same cold-start pattern can recur for any
country whenever it's first tracked, not just at the table's global launch. Features
include a 7-day trailing anomaly-corroboration count from `anomaly_findings` (Tier 1) —
viable now that both tables share the same 2026-09-09 starting line.

Backtested on a time-based (not random) held-out split, reporting MAE/RMSE against the
naive "predict no change from today" baseline — a forecasting model that can't beat
that baseline has no real skill, so the baseline's own MAE is stored alongside the
model's for direct comparison, not just the model's number in isolation. L2
regularization strength is chosen via a nested validation split over several candidates
rather than fixed to one guess, and gradient descent uses early
stopping (converged-loss check) rather than one iteration count assumed to suit every
horizon equally. Each run separately shadow-predicts every country from its latest
snapshot, graded later once that specific horizon's window resolves
(`src/lib/riskModelGrading.ts`, daily via `/api/admin/snapshot`, piggybacked onto that
route rather than its own cron) — this live-graded track record is the real calibration
evidence, stronger than the historical backtest alone, since these predictions are made
before their outcome is knowable.

Nothing from this reaches a user yet. A run is marked `promoted` in `risk_model_runs`
only once its backtest clears a real sample floor and its MAE beats the naive
persistence baseline — given the 2026-09-09 cutoff plus the 7-day burn-in plus each
horizon's own resolution time, nothing is trainable before **2026-09-17 at the
earliest** (the 1-day horizon, first to resolve). Training correctly logs "insufficient
data" and waits until then — the intended behavior: visibility is gated on measured
evidence, not a guessed calendar date.

## 10. Backend architecture — what's built, and why it deviates from the brief

**Current**: Next.js App Router, deployed entirely on Vercel (frontend + serverless API
routes), Postgres via Neon, no separate worker service.

The brief recommends *not* relying on Vercel alone for persistent ingestion workers.
That recommendation is correct, and this project hit it twice: first when the GitHub
Actions cron went silent for a week (2026-08-27 → 09-04, fixed by re-registering the
schedule), then when Vercel Hobby's Fluid compute allowance was **exceeded** (4h49m of
a 4h/month Active-CPU budget in the 30 days to 2026-09-19 — ~65% of it `/api/ingest`,
~26% the old SSE `/api/stream`, everything else seconds).

**Since 2026-09-19 the pipeline runs on GitHub Actions runners, not on Vercel.** This
repo is public, so Actions minutes are unlimited and free. Every scheduled job calls the
reusable `.github/workflows/_run-job.yml`, which checks out the repo, restores
`node_modules` from cache, and runs `npx tsx scripts/run-job.ts <job>` — the exact same
`src/lib/*` function the corresponding `/api/admin/*` route calls, in-process on the
runner, against Neon directly. Secrets (`DATABASE_URL`, `GEMINI_API_KEY`, …) are GitHub
Actions secrets with the same names Vercel holds. Vercel is left serving the UI and the
CDN-cached read routes, which is all a Hobby plan is really for.

| Job | Workflow | Cadence (UTC) |
| --- | --- | --- |
| `ingest` → `review-pending` → `generate-briefs` (chained, one run) | `ingest.yml` | :01, :16, :31, :46 — one database burst per cycle so Neon's compute can suspend between them (see §12); review is chained so rows are visible ~1 min after insert, and the review job purges the ISR feed cache when it finishes |
| `review-pending`, `generate-briefs` (manual only) | `review-pending.yml`, `generate-briefs.yml` | dispatch |
| `snapshot` (+ `country_feature_daily`, + prediction grading), `snapshot-flights` (+ anomaly scan), `audit-classifier` (+ gate sample) | `daily-snapshots.yml` | 18:00, 18:30, 20:00 |
| `grading-check` | `grading-check.yml` | Monday 15:00 — fails loudly if a week passed with no human gate grades |
| `migrate` | (manual: `npx tsx scripts/run-job.ts migrate`, or `/api/admin/migrate`) | after a schema change |
| `train-risk-model`, `train-narrative-clusters`, `train-text-classifier` | `train-*.yml` | Sunday 12:00, 12:30, 13:00 |

What remains on Vercel's side of scheduling:

- **A daily `/api/ingest` floor** (`vercel.ts`, 06:00 UTC) — the one job that is fully
  idempotent (events dedupe by URL) and whose silence would be user-visible fastest if
  GitHub's schedule trigger ever went quiet again. The daily snapshot jobs are
  deliberately NOT mirrored there: `snapshotCountryStates` inserts one row per country
  per call, so they must run from exactly one scheduler.
- **The `/api/admin/*` routes themselves** — kept as the manual/one-off entry points
  (`.github/workflows/admin-call.yml`) and as the fallback the floor above uses.

What was removed:

- **cron-job.org** used to hit `/api/ingest` and `/api/admin/review-pending` at
  :00/:15/:30/:45 on top of the Actions schedule — that overlap (plus the stream
  self-trigger below) is why ingest ran ~260×/day instead of ~96×. Its jobs should be
  disabled, or dropped to hourly as a pure backstop. Its 30s hard request timeout is
  what originally forced `runIngest` into a one-GDELT-category-per-cycle rotation;
  the runner has no such clock, but the rotation is kept because it also paces
  upstream request volume.
- **Self-triggering from the live stream.** The SSE route (`/api/stream`) is gone
  entirely — replaced by `GET /api/events/feed`, a stateless poll the client
  (`src/lib/useEventStream.ts`) calls every ~12s (60s when the tab is hidden). One
  ~40ms invocation per poll and nothing while idle, versus a function pinned open for
  45s per viewer.

Moving ingestion to a dedicated always-on worker (Railway/Fly.io/Render, per the
brief) is no longer necessary: an Actions runner per job is that worker, minus the
hosting bill. Supabase's free tier was considered as a home for the pipeline and
rejected — it would mean migrating the database off Neon for no compute the Actions
runners don't already provide (its Realtime product could replace the feed poll with a
Postgres-changes websocket, but only for a Supabase-hosted database).

**Serverless duration**: Vercel Hobby-tier functions are commonly documented at a 60s
ceiling; the `/api/admin/*` fallback routes keep their defensive `maxDuration` values
and short internal timeouts. On the runner, `scripts/run-job.ts` enforces its own
8-minute ceiling per job.

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
per-source integration notes and rejected-source reasoning; `docs/API_SOURCES.md`
carries the licensing table itself. This document is the map of how those pieces fit
together.

## 11. ML training inputs (2026-09-20)

Phase 0 of the ML roadmap — the pieces that have to exist *before* any model,
because they are the data no later date can back-fill:

- **`country_feature_daily`** (`src/lib/countryFeatures.ts`) — the wide daily feature
  snapshot, one upserted row per (country, UTC date), written by the `snapshot` job
  right after `country_state_history`. ~35 columns: the headline state, decayed weight
  per pillar, 24h/7d volume and severity, source diversity and Telegram/GDELT share,
  narrative novelty (share of the day's articles matching no learned cluster), latest
  aircraft/GNSS-jamming values with 14-day z-scores, and anomaly recency. Nothing here
  is modelled — every column is a `GROUP BY` over an existing table, so a model trained
  on it can be audited back to rows. `country_state_history` is untouched and stays the
  narrow series the Trends tab charts. Lags are not stored; they are a self-join at
  training time.
- **`narrative-novelty` anomaly signal** (`src/lib/narrativeNoveltyAnomaly.ts`) — the
  sixth signal in the daily scan: percent of a country's scored articles in a rolling
  24h bucket whose nearest cluster was further than that cluster's own threshold, z-
  scored against the country's prior days (≥ 3 articles per bucket, 14-day baseline,
  rises only, ≥ 25-point jump). Uses the novel/matched *verdict* rather than raw
  distance because the cluster map is retrained weekly and raw distances are not
  stationary across a retrain.
- **`grading-check`** — the weekly alarm that keeps the one non-Gemini feedback channel
  (human gate grades, §6) from silently producing nothing.
- **`migrate` job** — `src/lib/migrations.ts` now holds the idempotent statement list
  the `/api/admin/migrate` route always applied, so it can also run on the Actions
  runner.
- **Model registry + `/models` page** (`src/lib/modelRegistry.ts`, `model_registry`
  table, `GET /api/models`, `/models`) — every trainer writes one summary row per run
  (family, variant, held-out metrics, the naive baseline's metrics on the same rows,
  promoted flag, pointer to the family table's detail row), best-effort so a registry
  failure never fails a trainer. The public page lists the latest run per variant next
  to its baseline, the live graded track record of the shadow forecasts (with
  persistence MAE on the same graded rows), and the human gate-grading numbers. The
  rule it enforces: a model is shown next to what it had to beat, or not as a model.
- **Risk-model fix (2026-09-20)** — the shadow regressor was losing to persistence by
  10× because (a) the gradient-descent update with lr=0.1 and L2=10 multiplied weights
  by exactly zero each step, and that "conservative" candidate was the fallback
  whenever the purged inner split was empty — always, for a one-day training set; and
  (b) it predicted the score *level*, spending all capacity re-learning output ≈ input.
  Now: exact closed-form ridge, interleaved inner split when the temporal one is
  empty, and both models predict the horizon *change* (persistence = the zero model).
  Dry run on live data: MAE 2.98 vs. persistence 2.98 — at par, weights ≈ 0, the honest
  result until `country_feature_daily` accumulates.

## 12. Neon compute budget (2026-09-21)

Neon Free is **100 CU-hours/month**: at the 0.25 CU minimum that is ~13 h/day
awake, and the compute only suspends after 5 idle minutes. Storage (121 MB of
0.5 GB) and egress are not the constraint; wake-ups are. Three things keep it
asleep:

1. **Pipeline touches are batched.** ingest → review → briefs run as one chained
   Actions run every 15 min, so the database sees one ~40-60 s burst and ~10 idle
   minutes per cycle instead of separate wake-ups from each job's own offset.
2. **Viewer reads never wake it.** `/api/events/feed` is an ISR route handler
   (`export const revalidate = 900`, reads nothing from the request) served from
   Vercel's cache; the runner calls `POST /api/admin/revalidate` after each review
   so it regenerates exactly once per cycle. The client reconciles the full window
   every poll — the per-viewer `?since=` cursor, which made every poll its own
   cache key and its own query, is gone. `/api/risk` summaries are CDN-cached 15
   min (was 60 s). The remaining DB-backed read routes are on-click, 5-min cached.
3. **Compute size is pinned at 0.25 CU** (min and max) in the Neon console, so a
   burst cannot scale the hours up.

If usage still climbs, the next lever is a second Free project (each gets its own
100 CU-hours) holding the archive/ML tables, at the cost of two connection strings.

## 13. Chokepoints, sanctions and the storage budget (2026-09-22)

Three changes, in the order they were made, all against the constraint
that Neon Free stops at **0.5 GB** and the embedding corpus is what every
model downstream trains on.

**Embeddings halved.** `feed_archive.embedding` and
`classification_archive.embedding` moved from `vector(768)` (float32) to
`halfvec(768)` (float16), and the HNSW index was rebuilt with
`halfvec_cosine_ops`. Those two tables were 98 MB of a 130 MB database;
the database is now 86 MB. Verified lossless for the only thing any
consumer does with these vectors — rank by cosine distance: across 8
probe rows the top-10 neighbour set was identical before and after,
distances agreed to within 2.3e-5, and the only ordering changes were two
exact-tie pairs swapping. `narrative_clusters.centroid` and
`classifier_calibration_patterns.embedding` stay `vector` (101 rows
between them, nothing to save). The two `ADD COLUMN` statements in
`migrations.ts` were edited rather than appended — the documented
exception to that file's own rule, because a fresh database and the live
one must converge on the same column type or the index can only be valid
on one of them.

**Chokepoint transits are the seventh anomaly signal.**
`src/lib/sources/portwatch.ts` had said since 2026-09-08 that a raw
transit count is meaningless without each chokepoint's own baseline, and
that no history was kept to build one. `chokepoint_transit_history` is
that history, and `src/lib/chokepointHistory.ts` reads it through the
same `anomalyBaseline.ts` z-score engine every other signal uses. Three
things worth knowing:

- It did not have to wait. PortWatch's FeatureServer carries daily rows
  back to 2019-01-01, so the baseline was backfilled and the signal was
  live on its first run — the only signal in the scan with zero countries
  in `insufficient-baseline`. First real finding: Gibraltar Strait at 96
  transits against a 132.5 average over 28 days (z=3.10).
- `allowNegativeJump` is on. A **drop** is the disruption signal
  (blockage, closure, shipping routing around a threat); only the
  commercial-aircraft signal shares that.
- Findings are attributed to littoral states from an explicit
  hand-checked table (`CHOKEPOINT_COUNTRIES`), not by reverse-geocoding.
  A strait is by definition the water *between* countries, so a
  nearest-land lookup would pick one shore and silently drop the other:
  Kerch is a Russia **and** a Ukraine signal, and both see the finding.
  `anomaly_findings.category` carries the chokepoint's name.

Retention is 120 days (~3,300 rows, 1 MB). Upstream holds seven years and
a year of it would enable seasonality, but nothing reads seasonality yet.

**Sanctions designations, as context.** `src/lib/sources/sanctions.ts`
fetches the OFAC SDN list (19,393 entries, US government work, public
domain) and the EU consolidated list (6,234 entities, published for
reuse). Neither publisher offers a change feed, so `src/lib/sanctions.ts`
diffs each list against stored membership and records what was added and
removed. OpenSanctions was evaluated and rejected: its bulk data is free
for non-commercial use only, which would become a licensing problem given
this project's stated institutional direction.

- `sanctions_entry` stores only `(list, entry_id)` — membership is all the
  diff needs, and mirroring someone else's database would cost tens of
  megabytes to duplicate a public file. Names and programmes live on
  `sanctions_delta`, where they document one change at one time.
- Country attribution comes from the programme: OFAC by prefix
  (`UKRAINE-EO13662` → UA), EU by ISO3 (`IRN` → IR). 67% of OFAC and 88%
  of EU entries attribute; the rest are thematic (SDGT, SDNT, TERR) and
  stay **null** rather than being forced onto the designating state.
- A run that would change more than 25% of a list is discarded as a
  format change rather than published as news, and the first run for a
  list records membership silently instead of announcing 19,393 new
  designations.
- **Not scored into country risk.** That needs a new event category,
  which changes every country's score and touches the classifier, the
  pillars and the risk model's features — a deliberate separate change,
  not a side effect of adding a source. It ships as a context layer
  (`GET /api/layers/sanctions`), the same way travel advisories and trade
  balances did.

**Schedules.** The chokepoint snapshot rides `snapshot-flights`, which
already runs the anomaly scan. `sync-sanctions.yml` (Wednesdays 17:00
UTC) is the only new schedule, because a new wake-up costs real CU-hours
and everything else could ride a burst that already happens.

## 14. The alert engine (2026-09-22)

Until now this system detected, verified, corroborated, scored and
explained — and then waited to be looked at. `src/lib/alertEngine.ts` and
`src/lib/alertScoring.ts` are the part that reaches somebody.

**The unit is a country situation, not an article.** One alert says
"Country X changed, here is what changed, here is the evidence", anchored
to the events that drove it. Alerting per article would reproduce the
feed with a louder voice, which is the problem rather than the fix.

**Nothing decides a tier except arithmetic.** A tier is a threshold over
a weighted sum of six stored measurements, plus hard gates. No language
model participates, deliberately: an alert a model decided was important
cannot be audited, tuned, or defended to somebody asking why they were
woken up. Every input is stored on the alert row beside the verdict, so
`assessAlert` can recompute a months-old alert from its own row and must
land on the same tier — asserted in `scripts/system-regressions.test.ts`.

**The change gate is what makes it usable.** A dry run against live state
before this shipped made the case: with nothing changing anywhere in the
world, 14 countries still cleared a tier threshold on standing badness
alone — severity and volume are high every day in a war zone, so scoring
alone ranks a grinding conflict above a fresh coup. So no tier is
reachable without movement in one of the three state variables tracked
between runs (level, momentum, anomaly-signal count), held in
`alert_country_state`. `country_state_history` could not serve that
purpose: it is written once a day and the Trends tab charts it, whereas
alerts are evaluated every pipeline cycle.

**Tiers and their gates.**

| Tier | Score | Additional gates |
| --- | --- | --- |
| FLASH | 85 | level must have RISEN, to at least 3, with 2+ independent source families |
| PRIORITY | 55 | 2+ independent source families |
| WATCH | 35 | change gate only |
| ROUTINE | 20 | change gate only |

Independence is counted by source *family*, and every GDELT contribution
collapses to one: an aggregator echoing itself is not corroboration.

**Repeat suppression** is the tiering idea from Crucix's alert layer —
the concept only, written from scratch, since that project is AGPL and
this one carries no licence. First alert immediately, then 6h, 12h, 24h.
An escalation always escapes suppression: being told a level-2 country is
now level-4 matters more than having mentioned it an hour ago. Suppressed
rows are still written, with their reason, because a suppression rate
that creeps up is how a threshold gets found to need tuning.

**Verified live before shipping.** Cold start fired nothing (nothing can
have changed yet). Simulated escalations produced 3 PRIORITY and 2 WATCH
from 203 countries: Russia and Ukraine and Iran on level rises with 5, 6
and 3 independent families; Cameroon and Japan on momentum surges held
down to WATCH by the corroboration gate, each single-family. Japan's
carried two corroborating anomaly signals and an M5.1 earthquake as
evidence. A repeat pass suppressed all three PRIORITY alerts at 0.0h
against a 6h cooldown.

**Cost.** Rides `review-pending` inside the chained job, so no new
database wake-up. Retention is 180 days.

## 15. Exposure: severity is not impact (2026-09-22)

A magnitude-6 earthquake under empty desert used to score exactly like a
magnitude-6 under a capital, because the risk engine read severity and
nothing else. USGS, GDACS, EONET and FIRMS all report how big something
was; none of them reports how much it mattered. `src/lib/exposure.ts`
supplies the missing half.

**The measurement that justified it.** Across all 2,174 hazard events in
the database carrying usable coordinates: p10 0, p25 0, **median
10,375**, p75 67,363, p90 388,350, max 43.9M. **864 of them — 40% — sit
at exactly zero**: earthquakes out at sea, thermal anomalies over empty
forest, hurricanes still over water. Every one of those was scoring like
the same event in a city.

**How it works.** GeoNames `cities15000` (34,143 settlements over 15,000
people, CC BY 4.0) is loaded into `population_center`. For each hazard
event, `populationNear` sums the population within 100 km, linearly
de-weighted by distance, and stores the head count on
`events.population_exposed`. `exposureMultiplier` turns that into a
multiplier on the decayed severity weight, anchored so the **measured
median scores exactly 1.0** — switching the model on leaves the typical
event where it was and moves only the genuinely empty and the genuinely
crowded. Range is clamped to [0.4, 1.6].

**Three deliberate limits.**

1. **Hazards only.** `EXPOSURE_WEIGHTED_CATEGORIES` is earthquake,
   natural-disaster and climate-hazard. A coup, a border incident or a
   humanitarian emergency does not matter less for happening in a less
   crowded country; weighting political news by population would encode
   "events in big countries matter more", which is a bias, not a
   correction.
2. **Unknown is not zero.** NULL (an event from before the model) and -1
   (the backfill's "checked, not applicable") both return a neutral 1.
   Only a genuinely empty location earns the 0.4 floor. Without that
   guard the sentinel falls through to `log10(0)` and silently demotes
   every event with missing coordinates — turning "we do not know" into
   "this did not matter".
3. **It undercounts, by design of the data.** A settlement point set has
   no dispersed rural population, so a hazard over densely-farmed but
   un-urbanised land reads emptier than it is. The bias runs toward
   under-weighting, which is the safer direction: it can make a real
   event look ordinary, but it cannot invent a crisis where nobody lives.

**The before/after, run on live data before enabling.** 68 of 124
countries changed score, 38 up and 30 down — balanced, not a systemic
shift. Only **8 of 203 changed Pulse Level** (3 up, 5 down), and **no
level-4 country moved at all**, so the serious end of the picture is
untouched. Venezuela 2→3 and Italy 1→2 on hazards near people; Fiji 3→2,
Tonga, Paraguay, Botswana and Kazakhstan 2→1 on remote ones. Australia's
raw hazard weight fell 48% — 95 of its 105 events are FIRMS thermal
detections averaging 3,872 and 269 people nearby, i.e. the outback.
News-driven scores barely moved: Russia -3%, Iran +1%.

**Switching it off** is one constant, `EXPOSURE_WEIGHTING_ENABLED` in
`exposure.ts`. A code constant rather than an environment variable
because it changes published risk scores, so which state it was in on a
given day has to be answerable from the commit history rather than from
whatever two dashboards happened to be set to. Off resolves the SQL
factor to a literal `1`, so the query shape never changes.

The curve exists twice — JS for readers, SQL because the weight is summed
in Postgres over thousands of rows — and both are generated from the same
constants, with a regression test pinning the numbers.

**Correction (2026-09-23).** Until this date nothing computed exposure for
events ingested *after* the one-off backfill: every new hazard carried
NULL and scored at a neutral 1, so the model was quietly fading out of
the score as backfilled events aged past 30 days. The pass now runs after
every ingest, inside the `review-pending` job, and reads only the
settlements near the new events rather than all 34k (see §16).

## 16. Scoring version 3: stories, not articles (2026-09-23)

The score used to add up one number per **article**. Two measurements
against live data, taken before any change, showed what that was really
measuring:

- **Media echo.** 1,094 of the 5,231 events in the 30-day window (21%)
  were cross-outlet duplicates that `eventDedup.ts` had already found and
  hidden from the feed, yet `risk.ts` still counted in full. Saudi Arabia:
  194 of 289 (67%). A story five outlets carried scored five times.
- **Sensor volume.** Brazil read Extreme on 189 NASA FIRMS fire
  detections and essentially nothing else; Indonesia, Australia and
  Angola likewise. A satellite's detection count tracks land area and
  fire season, not consequence.

The effect: **23 countries at Extreme**, including the UK, Poland,
Australia and Brazil. The label had stopped meaning anything.

**What changed** (`src/lib/scoringMethod.ts`, `src/lib/risk.ts`):

1. **A duplicate adds nothing; the story it duplicates gets a bounded
   corroboration bonus**: `1 + 0.2·log2(1 + k)`, capped at 1.6, where `k`
   is the number of *distinct sources* that also carried it. Distinct
   sources, not articles: GDELT is one source however many domains it
   spans. A duplicate whose primary was rejected or kill-switched is an
   "orphan"; the earliest such orphan stands in for the story, once.
2. **Automated detection feeds saturate** per country-pillar-instrument:
   `20·(1 − e^(−raw/20))`. FIRMS, USGS and EONET only. News is never
   saturated, because the number of distinct stories is exactly what the
   score is meant to measure. GDACS isn't saturated either: its alerts are
   already impact-assessed, one per disaster. With the hazards pillar's
   1.3 weight, one instrument alone tops out near 26: **High, never
   Extreme**.
3. **Pulse Level thresholds 30/12/3 → 75/20/4**, each with a stated
   meaning. With a 3-day half-life, `r` distinct stories a day of severity
   `s` settle at `r·s·w / (ln2/3)`, which for severity-3 security stories
   is about 19.5 per daily story:

   | Level | Load | Meaning |
   |---|---|---|
   | Extreme | ≥ 75 | ~4+ distinct serious security stories a day, sustained |
   | High | ≥ 20 | ~1 a day, sustained |
   | Medium | ≥ 4 | ~1 every five days |

   Fixed constants, not percentiles: a percentile would put the same
   share of the world at Extreme whether the world was calm or at war.

**Before/after on live data.** Extreme 23 → 7 (Ukraine, Russia, Iran,
Yemen, Palestine, Saudi Arabia, Israel: the active war theatres). High:
10. Brazil → High, driven by hazards alone. Scores fell 15–40% for
news-heavy countries (Saudi Arabia −72%, Afghanistan −78%), and not at
all for countries with no duplicated coverage. The live API matched the
pre-deploy prediction exactly.

**Every score names its methodology.** `scoring_version` (1 original,
2 exposure, 3 this) is on `country_state_history`, `country_feature_daily`
and `risk_predictions`, with no column default, so a writer that forgets
it fails loudly. The forecasting model never pairs an input snapshot with
an outcome of a different version (a 30% drop on a methodology change is
not something that happened in the world). A prediction that resolves
across a change is **voided**: `graded_at` set, `actual_score` NULL,
excluded from every accuracy figure.

**Explained in the product.** The country panel states *why* a country
sits at its level (`explainPulseLevel` in `threat.ts`), derived from the
same rule `escalateThreatLevel` applies so the two cannot drift apart,
plus a collapsible "How this is scored" summary of the rules above.

**Data fixes found along the way.**
- Place labels: 42 of 100 live feed cards were headlined by raw
  coordinates. Detections now read "60 km SW of Sampit, Indonesia" from
  the GeoNames settlements. When the nearest town sits across a border,
  its own country is named ("95 km E of La Rinconada (Peru), Bolivia").
  Genuinely remote points read "Remote area, Brazil".
- USGS countries: 22% of in-window quakes had no country, because the
  news resolver knows countries, not US states. `usgsPlaceCountry` maps
  USGS's region suffixes explicitly (all 50 states and their postal codes,
  Timor Leste, Micronesia, Puerto Rico); open ocean stays unplaced. This
  fixed 57 existing quakes and one stale mis-attribution ("Gambiran Satu,
  Indonesia" filed under Iran by an older resolver).
- Three indexes with zero scans were dropped, one of which duplicated a
  UNIQUE constraint's own index.
