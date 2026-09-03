# GeoPulse → Global Risk Intelligence Platform: roadmap

This document captures the full blueprint GeoPulse is evolving toward —
"real-time global non-financial risk intelligence" across eight risk
pillars, not just the five geopolitical flashpoints the app started with —
and tracks what's implemented vs. still ahead. It's derived from a working
blueprint the project owner supplied; treat it as living design doc, not a
spec frozen in time.

## What's implemented (Phase 1)

- **Eight-pillar taxonomy** (`src/lib/pillars.ts`): Geopolitical & Security,
  Political & Governance, Climate & Environment, Natural & Biological
  Hazards, Human & Social, Infrastructure & Connectivity, Supply Chain &
  Resource Security, Cyber & Technology. Every event category maps to
  exactly one pillar.
- **Threat Level (1–5) + Momentum (0–100, directional) model**
  (`src/lib/threat.ts`, `src/lib/risk.ts`) replacing the old single
  continuous "risk score" the UI showed. Computed per pillar per country,
  then rolled up to an overall country Threat Level via an **escalation**
  rule (max of pillar levels, +1 if two or more pillars are independently
  Elevated+) rather than an average — a catastrophic single-pillar event
  isn't diluted by calm conditions elsewhere.
- **Momentum across two horizons** (24h and 7d, blended, weighted toward
  the shorter horizon) — the blueprint calls for 1h/24h/7d/30d; this build
  covers the two that matter most at current event volumes. See "Not yet
  implemented" below for closing the gap.
- **New event categories** feeding previously-uncovered pillars:
  `political-instability` and `humanitarian` (GDELT queries), `climate-hazard`
  (split out of GDACS/EONET flood/wildfire/drought events, previously lumped
  into `natural-disaster`), `infrastructure-outage` (IODA country-level
  internet outage detection).
- **New live sources**: IODA (internet outages, feeds the events table) and
  CISA KEV (actively-exploited vulnerabilities, surfaced as a global
  "Cyber & Technology" ticker layer since it has no country attribution).
- **Licensing/commercial-use registry** (`src/lib/sourceRegistry.ts`) for
  every integrated source.
- **Country pillar breakdown UI** (`CountryRiskPanel.tsx`): expanding a
  country now shows all eight pillars with their own Threat Level +
  Momentum, with uncovered pillars honestly marked "not yet tracked"
  rather than showing a fabricated score.
- **Fixed the live event stream** getting stuck on "RECONNECTING": the SSE
  connection now self-closes every ~45s (well under serverless duration
  limits) and the client reconnects from the last event id within ~1s,
  instead of risking an abrupt platform kill with no clean signal to react
  to quickly.

## Not yet implemented

Roughly in priority order:

1. **Supply Chain & Resource Security and Cyber & Technology pillars have
   no country-attributed event source yet.** CISA KEV covers part of the
   cyber story but isn't geolocated. Candidates: IMF PortWatch (port
   congestion/chokepoints) for supply chain; Cloudflare Radar or a country-
   level CVE/attack-traffic feed for cyber. Both need real evaluation of
   auth requirements and licensing before wiring in.
2. **1h and 30d momentum horizons.** Currently 24h/7d only. Adding 1h needs
   a source with genuinely sub-hourly update cadence to be meaningful (most
   current sources update every ~15 min at best); 30d is a straightforward
   SQL addition to `getCountryCategoryRows` in `risk.ts`.
3. **Cross-risk cascade engine** (blueprint section 8: cyclone → port closes
   → LNG exports stop → energy shortages → political pressure, etc.). Not
   started. This needs: (a) enough source coverage in Supply Chain/Energy to
   have something to cascade through, and (b) an actual correlation engine
   (geographic + temporal + semantic proximity → event clusters,
   `correlation_group_id`). Substantial standalone effort — don't bolt this
   on incrementally without designing the clustering approach first.
4. **Exposure/vulnerability modeling** (blueprint section 5: Severity ×
   Exposure × Vulnerability × Confidence). Today, Threat Level is driven
   purely by decayed event severity — a severity-5 earthquake in an empty
   region scores the same as one hitting a capital. Closing this gap needs
   population/infrastructure exposure data (WorldPop, port/energy
   infrastructure datasets) joined against event geometry.
5. **Broader V1 source list** from the blueprint (section 9) not yet
   integrated: ACLED, UCDP, ReliefWeb (blocked on an API key — see
   `src/lib/sources/README.md`), OCHA HAPI, IMF, WGI, UN Comtrade, WTO, EIA,
   Cloudflare Radar, RIPE Atlas/RIPEstat, OpenSky (already integrated as a
   standalone flights layer, not events), sanctions feeds (OFAC/EU/UK/UN/
   OpenSanctions).
6. **Normalized event object fields** from blueprint section 10 not in the
   current schema: `event_subtype`, `admin1`, `confidence`,
   `population_exposed`, `correlation_group_id`. Deferred rather than added
   speculatively — `confidence` and `correlation_group_id` in particular
   only earn their place once there's a real confidence model and the
   cascade engine (items 3–4) to populate them.
7. **Climate-risk depth** (blueprint section 11): heat anomaly, river-
   discharge percentile, flood probability, soil moisture, SST, wave
   conditions, etc. Currently the Climate & Environment pillar only sees
   discrete flood/wildfire/drought alerts from GDACS/EONET, not continuous
   anomaly series. ERA5/CHIRPS/GloFAS would be the next sources to evaluate.

## Design principles carried over from the blueprint

- **No falsely precise single score.** Threat Level (categorical, 1–5) and
  Momentum (0–100 + direction) stay separate, and a pillar with no wired
  source shows as "not tracked," never a fabricated Low.
- **Escalation, not averaging**, when rolling pillars up to a country level.
- **Severity vs. consequence are conceptually distinct** even before full
  exposure/vulnerability modeling lands — this is why item 4 above matters
  and shouldn't be skipped indefinitely.
- **Public accessibility ≠ commercial redistribution rights** — every
  source gets a licensing entry before being trusted for anything beyond
  this app's own non-commercial display.
