# GeoPulse: Roadmap

Status tracker and phased build order. For the *how it fits together* view, see
`docs/ARCHITECTURE.md`; for the full source table and licensing detail, see
`docs/API_SOURCES.md`. This file stays short and current — it points at those
documents rather than repeating them.

## MVP acceptance criteria — status

Checked against the platform brief's own §23 acceptance list:

| # | Criterion | Status |
|---|---|---|
| 1 | Global map loads with real live events | ✅ |
| 2 | 10–15 reliable sources actively ingesting | ✅ 6 event sources (GDELT, RSS×9, USGS, EONET, GDACS, IODA) + 12 standalone context/ticker sources — see `docs/API_SOURCES.md` |
| 3 | Events normalized into one common schema | ✅ `events` table, one shape regardless of source — see gaps in ARCHITECTURE.md §3 for the fuller schema not yet needed |
| 4 | Events mapped to countries and risk pillars | ✅ every category → exactly one pillar (`src/lib/pillars.ts`) |
| 5 | Duplicate events substantially reduced | ⚠️ Partial — URL-uniqueness + 24h recency filter; no cross-source semantic dedup (needs the correlation engine) |
| 6 | Country Threat Level + Momentum | ✅ |
| 7 | Each pillar has Threat Level + Momentum + recent events + drivers | ✅ 6 of 8 pillars covered by a live source; Supply Chain and Cyber (country-attributed) honestly show "not tracked" |
| 8 | Click a country → what changed, why, evidence | ✅ Feed tab filtered to that country; Risk tab has the pillar breakdown |
| 9 | Click an event → source, timestamp, location, severity, confidence, related events | ⚠️ Partial — source/timestamp/location/severity/category all shown; no confidence score or "related events" (needs correlation engine) |
| 10 | API failures visible internally | ✅ `GET /api/admin/health`, this session — no UI page rendering it yet |
| 11 | Source licensing documented | ✅ `src/lib/sourceRegistry.ts` + `docs/API_SOURCES.md` |
| 12 | Deployed and publicly accessible | ✅ https://geopulse-green.vercel.app |

**9 of 12 fully met, 2 partial, all partials tied to the same missing piece: the event
correlation engine.**

## Phased build order (brief §18, reconciled against what's actually built)

- **Phase 1–2** (schema, country metadata, USGS/EONET/GDACS/GDELT): done.
- **Phase 3** (ACLED, UCDP, ReliefWeb, UNHCR/OCHA, Cloudflare/RIPE): not started.
  ReliefWeb specifically blocked (see API_SOURCES.md); the rest need API key
  registration decisions from the account owner or further endpoint verification.
- **Phase 4** (structural country context — World Bank, WGI, IMF, Comtrade, WTO, EIA,
  FAOSTAT): World Bank GDP/population wired as standalone tickers only, not joined to
  the risk model. WGI specifically blocked (dead indicator codes on the live API —
  see API_SOURCES.md). Rest not started.
- **Phase 5** (event clustering, pillar mapping, Threat Level engine, Momentum
  engine): pillar mapping + Threat Level + Momentum engines are **done**. Event
  clustering is **not started** — this is the single highest-leverage remaining piece,
  since acceptance criteria 5 and 9 both trace back to it.
- **Phase 6** (frontend — global map, country cards, country pages, event detail,
  source transparency): done, modulo "related events" on event detail (blocked on
  clustering).
- **Phase 7** (cross-risk relationships, alerts, historical charts, search,
  filtering): not started. Historical charts additionally need a
  `country_state_history` snapshot table that doesn't exist yet (ARCHITECTURE.md §6.3).

## Immediate next priorities, in order

1. **Event correlation engine.** Unblocks two acceptance criteria at once (dedup
   quality, "related events" on event detail) and is the prerequisite for the cascade
   model. Design the clustering approach (geographic + temporal + semantic proximity,
   confidence ladder per brief §5) before writing code — this is standalone work, not
   an incremental bolt-on.
2. **Supply Chain & Resource Security pillar coverage.** Currently the only pillar
   with zero signal of any kind. IMF PortWatch is the most promising unverified
   candidate.
3. **`country_state_history` snapshot table.** Needed for any historical charting and
   for country-relative Momentum baselining (ARCHITECTURE.md §5).
4. **Real scheduled ingestion**, decoupled from site visits. The self-triggering
   stream-based ingest (ARCHITECTURE.md §7) is a working mitigation, not the intended
   long-term mechanism — the originally-intended GitHub Actions cron has never fired
   once, root cause undiagnosed. Fixing that, or standing up a dedicated worker
   service (Railway/Fly.io/Render per the brief), is the top infrastructure item.
5. **Admin health panel UI.** The data exists (`GET /api/admin/health`); it just
   isn't rendered anywhere yet.
6. **Broader source coverage** per `docs/API_SOURCES.md`'s prioritized candidate list
   — ACLED/UCDP for conflict depth, Cloudflare Radar/RIPE/FIRMS for infrastructure
   and climate depth, sanctions feeds for Political & Governance.

## Design principles (unchanged, worth restating)

- **No falsely precise single score.** Threat Level (categorical, 1–5) and Momentum
  (0–100 + direction) stay separate; a pillar with no wired source shows "not
  tracked," never a fabricated Low.
- **Escalation, not averaging**, when rolling pillars up to a country level.
- **News classification errs toward under-claiming risk, not over-claiming it.**
  Explainer/retrospective headlines, routine diplomacy (state visits, signed
  agreements, joint exercises), and passing mentions are filtered before they ever
  reach the severity model — severity defaults to 1 (Low), rising only on actual
  escalation language.
- **Country attribution follows the article's actual subject**, not just any country
  name that happens to appear in the text — resolved by earliest mention in the
  headline first, recognizing demonyms and major cities/leaders, falling back to the
  snippet only when the headline itself names nothing.
- **Public accessibility ≠ commercial redistribution rights** — every source gets a
  licensing entry (`docs/API_SOURCES.md`) before being trusted for anything beyond
  this app's own display.
- **Don't build ahead of a consumer.** Schema fields, tables, and integrations are
  added when something reads them, not speculatively — see ARCHITECTURE.md §3 for
  why the event schema is smaller than the brief's full normalized model.
