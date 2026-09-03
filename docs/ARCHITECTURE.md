# GeoPulse: Technical Architecture

A real-time global **non-financial** risk intelligence platform. This document is the
architecture reference requested against the platform brief — inspired by the broad
category of world-monitoring dashboards, built from GeoPulse's own taxonomy, scoring
logic, schema, and source integrations. No code, UI, scoring logic, or data handling
was copied from any other product; everything described here was designed and
implemented directly against the brief's own requirements.

This is a living document. Where something in the brief isn't built yet, that's stated
plainly rather than glossed over — see the **Gap analysis** at the end.

## 1. Product model

Every country carries two independent measures, never collapsed into one number:

- **Threat Level** (1–5, categorical) — how serious is the current threat environment.
- **Momentum** (0–100 + direction) — how fast is it changing.

Both exist at two levels: **per pillar** (one of eight) and **overall** (rolled up from
pillars via escalation, not averaging). Implemented in `src/lib/threat.ts` and
`src/lib/risk.ts`; the full worked derivation, with live numbers, is published at
the "Country Risk Methodology" artifact from this session — regenerate it any time
by asking for a walkthrough with current data.

### 1.1 Computation pipeline

```
raw event (GDELT/RSS/USGS/EONET/GDACS/IODA)
  → classify (category + severity + country)          src/lib/classify.ts
  → store                                              events table
  → decay-weight by age (3-day half-life)              src/lib/risk.ts
  → sum into 8 pillars, per country                    src/lib/risk.ts
  → weight → pillar Threat Level (threshold table)     src/lib/threat.ts
  → recent-vs-prior window → pillar Momentum           src/lib/threat.ts
  → escalate pillars → country Threat Level             src/lib/threat.ts
  → driver pillar's momentum → country Momentum         src/lib/risk.ts
```

Threat Level thresholds and the escalation rule (max of pillars, +1 when 2+ pillars are
independently Elevated+, capped at 5) are implemented exactly as specified in the brief.
Nothing here is a "Country Risk Score = 83/100" — a pillar with no wired source shows
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
| Geopolitical & Security | **Covered** | GDELT (5 flashpoint queries), RSS wire keyword classification |
| Political & Governance | **Covered** | GDELT (coup/election/emergency-rule query), RSS |
| Climate & Environment | **Covered** | GDACS + NASA EONET (flood/wildfire/drought split out from hazards) |
| Natural & Biological Hazards | **Covered** | USGS (earthquakes), GDACS + EONET (cyclone/volcano/tsunami/severe storm) |
| Human & Social | **Covered** | GDELT (famine/displacement/humanitarian-crisis query) |
| Infrastructure & Connectivity | **Covered** | IODA (country-level internet outage detection) |
| Supply Chain & Resource Security | **Not tracked** | none wired — see Gap analysis |
| Cyber & Technology | **Partial** | CISA KEV as a global (non-country-attributed) ticker only |

`COVERED_PILLARS` in `pillars.ts` is the literal boolean gate the UI reads — this table
is generated from that constant, not aspirational.

## 3. Event model

Current schema (`src/db/schema.ts`, one `events` table):

```
id, source, url (unique), title, summary, category, location, country (iso2, nullable),
lat, lon, severity (1–5), published_at, created_at
```

This is deliberately smaller than the brief's full normalized event model
(`event_subtype`, `admin1/admin2`, `confidence`, `fatalities`, `population_exposed`,
`correlation_group_id`, `raw_payload_hash`, `source_count`, `independent_source_count`,
`geometry`, `duplicate_group_id`, etc.). Every field that's missing is missing because
nothing downstream consumes it yet — adding columns with no reader is exactly the kind
of premature schema-first design the brief itself warns against in section 22. The
**Gap analysis** below sequences when each group of fields earns its place (tied to the
feature that would actually read it — correlation engine, exposure model, etc.).

`raw_payload_hash`/`raw_payload_location` (reproducibility) is the one field from that
list worth adding early regardless of what consumes it, since it's cheap now and
expensive to backfill later — flagged as a fast-follow in the roadmap.

## 4. Source registry & licensing

`src/lib/sourceRegistry.ts` is a typed, in-code provider table (not yet a DB table —
see Gap analysis) covering every source currently wired: GDELT, RSS wires, USGS, NASA
EONET, GDACS, IODA, CISA KEV, Frankfurter/ECB, the community currency CDN, World Bank,
ECB SDW, Eurostat, BIS, CFTC, CoinGecko, GitHub, CelesTrak, OpenSky, adsb.lol,
Open-Meteo, Finnhub. Each row records provider, license, `commercial_use`,
`redistribution_allowed`, `attribution_required`, `caching_allowed`, rate limit,
`api_key_required`, and `terms_last_checked` — the exact field set the brief specifies,
implemented as TypeScript types rather than a DB schema for now (no UI currently reads
it back; see Gap analysis for when it should move to Postgres).

**Sources evaluated and explicitly rejected**, with reasons on record (see
`src/lib/sources/README.md`):

- **ReliefWeb** — v1 decommissioned, v2 requires a registered `appname` (an API key in
  practice). Not integrated; Human & Social coverage comes from GDELT instead.
- **World Bank Worldwide Governance Indicators** — the brief's suggested indicator
  codes (`CC.EST`, `PV.EST`, etc.) resolve to an *archived* World Bank data source and
  return "not found" on live queries; the current WGI dataset (source id 3) isn't
  reachable through the standard Indicators API endpoint used elsewhere in this app.
  Not integrated pending a working query path — see Gap analysis.
- **gpsjam.org** — no documented public endpoint, fetched server-side by their own app
  only.

## 5. Momentum engine

Implemented horizons: **24h vs. prior 24h**, **7d vs. prior 7d**, blended 60/40 toward
the shorter window. The brief's suggested 1h and 30d horizons are not implemented —
1h needs a source with genuinely sub-hourly cadence to be meaningful (most current
sources update on the order of 15–60 minutes at best), and 30d is a straightforward
SQL addition to the existing `getCountryCategoryRows` query whenever a consumer needs
it (the trend-chart use case in the country-state-history gap below).

Momentum is **not** baselined against each country's own historical norm yet (the
brief's "100 protests/month is normal for country X" point) — today's recent-vs-prior
comparison is the same shape for every country. Country-relative baselining needs
enough historical event volume accumulated per country to be meaningful, which the
system doesn't have yet since it's young. Tracked in the roadmap once
`country_state_history` exists to compute baselines from.

## 6. What's NOT built yet (honest gap list)

Deliberately not attempted this pass, in the order they'd actually get built:

1. **Event correlation / clustering engine** (brief §5) — no geographic/temporal/
   semantic clustering exists. Every event is independent today; GDELT dedup happens
   only at the URL level. This is real, substantial, standalone work — don't bolt it
   on incrementally without designing the clustering approach first.
2. **Cross-risk cascade model** (brief §9) — no `causes`/`affects`/`depends_on`-style
   relationship schema exists. Needs (1) above as a prerequisite (you cluster events
   before you can trace how clusters transmit).
3. **Country state history / time-series** — Threat Level and Momentum are computed
   fresh on every request from the live `events` table; nothing is snapshotted, so
   there's no "chart this country's Threat Level over the last 30 days" yet. Needs a
   `country_state_history` table + a scheduled snapshot job.
4. **Severity × Exposure × Vulnerability model** (brief §6) — Threat Level today is
   driven purely by decayed event severity. A severity-5 earthquake in an empty region
   scores the same as one hitting a capital. Closing this needs population/
   infrastructure exposure data (WorldPop, port/energy infrastructure) joined against
   event geometry — real, sequenced work, not a quick add.
5. **Structural country context** (GDP, trade dependence, governance indicators) —
   World Bank GDP/population are wired as standalone ticker layers (`gdp`, `population`
   in `src/lib/dataLayers.ts`), not joined into the risk/exposure model. WGI itself is
   currently unreachable (see §4). IMF, UN Comtrade, WTO, EIA, FAOSTAT: not started.
6. **Broader source coverage**: ACLED, UCDP (need registered API keys — a decision for
   the account owner, not something to sign up for silently), Cloudflare Radar, RIPE
   Atlas/RIPEstat, NASA FIRMS (needs a free MAP_KEY), AISstream, sanctions feeds
   (OFAC/EU/UK/UN), OpenSanctions.
7. **Admin health panel UI** — the data now exists (`GET /api/admin/health`, this
   session), but there's no page rendering it yet.
8. **PostGIS** — not adopted. Current geometry is plain `lat`/`lon` doubles with no
   spatial queries anywhere in the codebase; adopting PostGIS now would be a schema
   migration in search of a consumer. Revisit once the correlation engine needs real
   geographic proximity queries (`ST_DWithin` etc.) rather than naive lat/lon math.
9. **AI summarization** (brief §17) — not implemented. The one LLM integration that
   existed (`classifyBatch` in `src/lib/classify.ts`) is dormant because it requires a
   Vercel AI Gateway account with billing enabled; the live classifier
   (`classifyByKeywords`) is a free, deterministic, keyword/heuristic replacement, kept
   deliberately in the same file as a drop-in upgrade path if billing is ever enabled.

## 7. Backend architecture — what's built, and why it deviates from the brief

**Current**: Next.js App Router, deployed entirely on Vercel (frontend + serverless API
routes), Postgres via Neon, no separate worker service.

The brief recommends *not* relying on Vercel alone for persistent ingestion workers.
That recommendation is correct, and this session hit exactly the failure mode it
warns about: the originally-intended scheduling mechanism (a GitHub Actions cron
calling `/api/ingest` every ~15 minutes) has **never fired once**, verified against
GitHub's own Actions run history — for the entire life of this repository, on this
deployment or the previous one. Root cause undiagnosed (no GitHub token available this
session to inspect repo Actions settings).

Rather than leave the app dependent on infrastructure that's silently not working, the
live SSE stream route (`src/app/api/stream/route.ts`) now opportunistically triggers a
background ingest run on every new connection, gated to at most once per ~10 minutes
per warm instance. In practice: **the app self-refreshes whenever someone has it
open**, using Next's `after()` API to guarantee the trigger request actually gets sent
rather than being silently dropped when the stream's own response completes.

This is a genuine, working mitigation — not a substitute for fixing real scheduled
ingestion. It has one real limitation the brief anticipates: if literally nobody
visits the site for an extended period, ingestion pauses. The daily Vercel cron
(`vercel.ts`) remains as a once-a-day floor (Vercel Hobby plan caps custom cron
frequency at once/day — this is a real platform limit, not a design choice). Fixing
GitHub Actions properly, or moving ingestion to a dedicated always-on worker (Railway/
Fly.io/Render, as the brief suggests) is the correct long-term fix and is on the
roadmap — it needs credentials/access this session didn't have.

**Serverless duration**: Vercel Hobby-tier functions are commonly documented at a 60s
ceiling; this project's Fluid Compute setting has empirically allowed a full ~60–90s
ingest cycle to complete in direct testing this session. `/api/ingest` and
`/api/stream` are both written defensively regardless (short internal timeouts, fast
per-source failure, self-closing streams) rather than assuming a generous budget.

## 8. Deployment

- **Frontend + API routes**: Vercel (Next.js App Router, Node.js runtime).
- **Database**: Neon Postgres (serverless HTTP driver, `@neondatabase/serverless`).
- **Ingestion trigger**: self-triggered from the live stream (see §7) + a daily Vercel
  cron floor. No dedicated worker service exists yet.
- **Secrets**: Vercel project environment variables (`DATABASE_URL`, `CRON_SECRET`
  optional, `FINNHUB_API_KEY` optional) — see `.env.example` for the full, current
  list, generated by grepping the codebase for every `process.env.*` read rather than
  guessed.
- **Observability**: `source_health` table + `GET /api/admin/health` (this session) —
  per-source last-attempt/last-success/last-error, so an upstream outage is visible
  without triggering ingest manually and reading through error arrays.

Deploying a second, independent worker service (Railway/Fly.io/Render) for real
scheduled ingestion — decoupled from anyone visiting the site — is the top backend
infrastructure item on the roadmap.

## 9. What this document intentionally does not repeat

`docs/ROADMAP.md` carries the phased build order and day-to-day status; the
"Country Risk Methodology" artifact carries the fully worked Threat Level/Momentum
derivation with live numbers; `src/lib/sources/README.md` carries per-source
integration notes and rejected-source reasoning; `src/lib/sourceRegistry.ts` carries
the licensing table itself. This document is the map of how those pieces fit together.
