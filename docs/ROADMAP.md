# GeoPulse: Roadmap

Status tracker and phased build order. For the *how it fits together* view, see
`docs/ARCHITECTURE.md`; for the full source table and licensing detail, see
`docs/API_SOURCES.md` and `docs/SOURCE_CREDIBILITY.md`. This file stays short and
current — it points at those documents rather than repeating them. Refreshed
2026-09-08 after a full codebase audit found this had drifted significantly behind
what's actually built (source counts, the AI/ML layer, Telegram, and the correlation/
confidence work below all postdate the previous version of this file).

## MVP acceptance criteria — status

Checked against the platform brief's own §23 acceptance list:

| # | Criterion | Status |
|---|---|---|
| 1 | Global map loads with real live events | ✅ |
| 2 | 10–15 reliable sources actively ingesting | ✅ GDELT, 35 RSS wires, ~18 Telegram channels, USGS, EONET, GDACS, IODA, FIRMS (8 event sources) + 12 standalone context/ticker sources — see `docs/API_SOURCES.md` |
| 3 | Events normalized into one common schema | ✅ `events` table, one shape regardless of source — see gaps in ARCHITECTURE.md §3 for the fuller schema not yet needed |
| 4 | Events mapped to countries and risk pillars | ✅ every category → exactly one pillar (`src/lib/pillars.ts`) |
| 5 | Duplicate events substantially reduced | ✅ URL-uniqueness + 24h recency filter, plus cross-outlet near-duplicate merging (`src/lib/eventDedup.ts`, Jaccard similarity over filtered word sets) — same-story reports from different outlets collapse into one feed card with "Also reported by" sources |
| 6 | Country Pulse Level + Momentum | ✅ (the brief's "Threat Level" — relabeled user-facing, see ARCHITECTURE.md §1) |
| 7 | Each pillar has Pulse Level + Momentum + recent events + drivers | ✅ 6 of 8 pillars covered by a live source; Supply Chain and Cyber (country-attributed) honestly show "not tracked" |
| 8 | Click a country → what changed, why, evidence | ✅ Feed tab filtered to that country (DB-backed, not just the live buffer); Risk tab has the pillar breakdown; daily AI-generated situation briefs (`src/lib/countryBriefs.ts`) |
| 9 | Click an event → source, timestamp, location, severity, confidence, related events | ✅ source/timestamp/location/severity/category all shown; a source-diversity confidence tier (single-source/corroborated/cross-confirmed, `src/lib/correlation.ts`) per event; cross-outlet duplicate sources shown as related via `eventDedup.ts`; semantic "similar events" via embeddings (`GET /api/events/[id]/similar`). ⚠️ Still no broader geographic/temporal correlation across genuinely *distinct-but-linked* events (e.g. a strike → a retaliation days later) — see ARCHITECTURE.md Gap analysis §1. |
| 10 | API failures visible internally | ✅ `GET /api/admin/health` — no UI page rendering it yet |
| 11 | Source licensing documented | ✅ `src/lib/sourceRegistry.ts` + `docs/API_SOURCES.md`; every RSS/Telegram outlet also individually vetted for bias/reliability (`docs/SOURCE_CREDIBILITY.md`) |
| 12 | Deployed and publicly accessible | ✅ https://geopulse-green.vercel.app |

**11 of 12 fully met, 1 partial** (broader cross-event correlation, tied to the same
missing piece as before: a real clustering engine beyond near-duplicate merging).

## What's been built beyond the original MVP list

Not covered by the brief's own acceptance criteria, but now core to the live product:

- **A pre-publish Gemini review gate** and **post-hoc classifier audit** — every
  classified item is independently re-checked before and after going live.
- **A recursive calibration loop** (`classifier_calibration` table) — corrections from
  real reviews get fed back into every future audit prompt, so the audit system
  measurably improves over time instead of repeating the same mistakes.
- **Telegram ingestion** (~18 channels) with a translation pipeline for non-English
  posts.
- **Semantic similarity search** (Gemini embeddings + pgvector) for "similar events."
- **Daily AI country situation briefs**, strictly grounded on real recent events.
- **Statistical anomaly detection** (2026-09-09) — generalized beyond the original
  aircraft-only z-score into one shared engine (`anomalyBaseline.ts`) applied to five
  signals: military aircraft, commercial aircraft (flags large drops — airspace
  closures — not just rises), GPS/GNSS jamming, event volume per country, and event
  volume per country×category. Findings persist to `anomaly_findings` (one daily scan,
  piggybacked on the existing `/api/admin/snapshot-flights` cron, zero new cron
  entries) and surface as a signal-agnostic "N unusual signals" badge on the Risk tab
  and a recent-anomalies section on the Trends tab — a count, not a blended score, per
  this file's own no-falsely-precise-score principle. Live data layers: commercial/
  military flights, weather, GDP, population, forex, CFTC positioning, cyber (CISA KEV).
- **Daily country Pulse Level/Momentum snapshots** (`country_state_history`) — feeds
  the Trends tab's history charts. Momentum itself is still not baselined against a
  country's own history (see ARCHITECTURE.md §5) — the anomaly signals above are a
  separate, complementary layer (raw counts vs. each country's own trailing baseline),
  not a baselined momentum.
- **Nine new context layers** (2026-09-08, sourced from a deep-dive into
  worldmonitor.app's own public data-fetching code): GPS/GNSS jamming, submarine
  cable exposure, US travel advisories (also in the country dossier), World Bank
  grid-loss, OWID energy mix, FAO Food Price Index, Open-Meteo air quality, IMF
  PortWatch chokepoint traffic, and UN Comtrade trade partners. All unscored,
  display-only — see `docs/API_SOURCES.md`'s Integrated table.

See `docs/ARCHITECTURE.md` for how all of this fits together.

## Phased build order (brief §18, reconciled against what's actually built)

- **Phase 1–2** (schema, country metadata, USGS/EONET/GDACS/GDELT/RSS/Telegram/FIRMS):
  done.
- **Phase 3** (ACLED, UCDP, ReliefWeb, UNHCR/OCHA, Cloudflare/RIPE): not started.
  ReliefWeb and UCDP specifically blocked (see API_SOURCES.md — UCDP's GED needs a
  manually-approved access token and has an ~18-month data lag, worse than ACLED's
  already-rejected weekly lag); the rest need API key registration decisions from the
  account owner or further endpoint verification. Humanitarian coverage today comes
  from GDELT/RSS/Telegram keyword classification, not a dedicated humanitarian-data
  API.
- **Phase 4** (structural country context — World Bank, WGI, IMF, Comtrade, WTO, EIA,
  FAOSTAT): World Bank GDP/population/grid-loss wired as standalone tickers, not
  joined to the risk model. IMF PortWatch (port congestion) and UN Comtrade (top
  trade partners) integrated 2026-09-08 as unscored context layers, same treatment —
  see API_SOURCES.md. WGI specifically blocked (dead indicator codes on the live API
  — see API_SOURCES.md). WTO, EIA, full FAOSTAT not started (FAO Food Price Index, a
  simpler global-index cut of the same territory, is integrated as a context layer).
- **Phase 5** (event clustering, pillar mapping, Pulse Level engine, Momentum
  engine): pillar mapping + Pulse Level + Momentum engines are **done**.
  Near-duplicate event clustering (same story, multiple outlets) is **done**
  (`src/lib/eventDedup.ts`), with a source-diversity confidence tier layered on top
  (`src/lib/correlation.ts`). Broader semantic/geographic correlation across
  distinct-but-related events is **not started** — the remaining highest-leverage
  piece for full "related events" coverage.
- **Phase 6** (frontend — global map, country cards, country pages, event detail,
  source transparency): done, including cross-outlet "Also reported by" sources and
  semantic "similar events" on event detail; broader cross-event correlation still
  open (see Phase 5).
- **Phase 7** (cross-risk relationships, alerts, historical charts, search,
  filtering): historical charting is **done** — `country_state_history` snapshots
  (daily cron, `vercel.ts` → `/api/admin/snapshot`) are charted live in the frontend's
  Trends tab (`TrendsPanel.tsx` → `GET /api/history`) with a deterministic trend
  summary. Statistical anomaly detection is **done** (2026-09-09, see above) —
  `anomaly_findings` (daily scan, `/api/admin/snapshot-flights`) backs a generalized
  anomaly badge on both the Risk and Trends tabs, across five signals rather than just
  aircraft. Cross-risk relationships, alerting, and search are not started.
- **AI/ML layer** (not in the brief's original phasing, built alongside Phase 6-7):
  Gemini pre-publish review, post-hoc audit, recursive calibration, embeddings/similar
  events, daily country briefs, Telegram translation — all **done** and live. See
  `docs/ARCHITECTURE.md` §6.

## Immediate next priorities, in order

1. **Broader event correlation engine**, beyond the near-duplicate merging already
   done (`eventDedup.ts`). Design the clustering approach (geographic + temporal +
   semantic proximity, confidence ladder per brief §5) before writing code — this is
   standalone work, not an incremental bolt-on.
2. **Supply Chain & Resource Security pillar coverage.** Still the only pillar with
   zero SCORED signal — IMF PortWatch (chokepoint vessel transits) is now integrated
   as an unscored context layer (2026-09-08), which gives an analyst something to look
   at but doesn't feed the risk model itself. Turning chokepoint congestion into an
   actual scored pillar signal (a real historical baseline per chokepoint, since raw
   counts alone aren't comparable across wildly different-traffic straits) is the
   next real step here, not a new source search.
3. **A dedicated always-on worker**, decoupled from any single external scheduler.
   cron-job.org is the real primary ingest trigger and is working reliably; GitHub
   Actions now also fires reliably as a real backup after a 2026-09-04 fix. All
   triggers still ultimately depend on this one Vercel deployment, so standing up a
   dedicated worker service (Railway/Fly.io/Render per the brief) so ingestion isn't
   dependent on Vercel at all remains the top infrastructure item — just a less
   urgent one now that there are multiple independent triggers instead of one.
4. **Admin health/observability panel UI.** The data exists (`GET /api/admin/health`,
   `GET /api/admin/ai-usage`, `GET /api/admin/translation-usage`); none of it is
   rendered anywhere yet.
5. **Broader source coverage** per `docs/API_SOURCES.md`'s prioritized candidate list
   — Cloudflare Radar/RIPE for infrastructure and climate depth, sanctions feeds for
   Political & Governance. ACLED and UCDP are both confirmed blocked (lag/access
   terms, see API_SOURCES.md), not open items.
6. **X/Twitter ingestion** — a real structural gap, not a rounding error. A
   2026-09-04 pass sampling ISW/CTP's own source citations across Russia-Ukraine,
   Iran, China-Taiwan, and Korea found this product has zero X/Twitter coverage,
   and that the gap costs noticeably more on China-Taiwan and Korea specifically
   — those two theaters' primary sourcing (Taiwan's MND, Israeli/Yemen military
   correspondents, CENTCOM) leans on named X accounts far more than on Telegram
   or RSS-able outlets. Needs the X API (paid tier for any real read access) — a
   deliberate cost/scope decision, not a quick add.

## Design principles (unchanged, worth restating)

- **No falsely precise single score.** Pulse Level (categorical, 1–4) and Momentum
  (0–100 + direction) stay separate; a pillar with no wired source shows "not
  tracked," never a fabricated Low.
- **Escalation, not averaging**, when rolling pillars up to a country level.
- **News classification errs toward under-claiming risk, not over-claiming it.**
  Explainer/retrospective headlines, routine diplomacy (state visits, signed
  agreements, joint exercises), and passing mentions are filtered before they ever
  reach the severity model — severity defaults to 1 (Low), rising only on actual
  escalation language.
- **Country attribution follows the article's actual subject** — the country at risk
  from or affected by the event, not just any country name that happens to appear —
  resolved by earliest mention in the headline first, falling back to the snippet
  only when the headline itself names nothing.
- **Public accessibility ≠ commercial redistribution rights** — every source gets a
  licensing entry (`docs/API_SOURCES.md`) before being trusted for anything beyond
  this app's own display; every RSS/Telegram outlet also gets an independent bias/
  reliability check (`docs/SOURCE_CREDIBILITY.md`) before being wired in.
- **Don't build ahead of a consumer.** Schema fields, tables, and integrations are
  added when something reads them, not speculatively — see ARCHITECTURE.md §3 for
  why the event schema is smaller than the brief's full normalized model.
- **A review should make the system better next time, not just fix one article.**
  The recursive calibration loop (ARCHITECTURE.md §6) exists specifically so a real
  correction feeds back into future judgment instead of being a one-shot fix.
