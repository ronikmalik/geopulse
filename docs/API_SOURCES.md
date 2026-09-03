# Source registry

The prioritized, verified source table requested against the platform brief. Every row
marked **integrated** has actually been called successfully by this codebase (not just
read about) — see the verification note per row. Every row marked **candidate** has
either been evaluated and found unworkable right now, or is a genuine next-phase
target not yet attempted. `src/lib/sourceRegistry.ts` carries the same licensing fields
in code for the integrated rows; this file is the fuller picture including what didn't
make it in and why.

Fields follow the brief's requested schema: provider, endpoint, auth, rate limit,
license/commercial-use/redistribution, refresh interval, adapter path, and known
limitations.

## Integrated

| Source | Endpoint | Auth | License / commercial use | Refresh | Adapter | Limitations |
|---|---|---|---|---|---|---|
| GDELT DOC 2.0 | `api.gdeltproject.org/api/v2/doc/doc` | none | Public domain, commercial use OK | ~10 min (self-triggered) | `src/lib/sources/gdelt.ts` | 3h timespan window; has shown extended outages this session (verified via direct `curl` from two independent networks — not a Vercel-specific issue) |
| RSS (BBC, Al Jazeera, Guardian, NYT, NPR, DW, France24, CNA, CBS) | per-outlet RSS URL | none | Publisher-specific; headline+link only, no full-text reproduction | ~10 min | `src/lib/sources/rss.ts` | No official API; treated as syndication, not scraping — each outlet publishes the feed itself |
| USGS Earthquake GeoJSON | `earthquake.usgs.gov/.../summary/4.5_day.geojson` | none | US government work, public domain | ~10 min | `src/lib/sources/usgs.ts` | M4.5+ only, rolling 24h/day window feeds |
| NASA EONET v3 | `eonet.gsfc.nasa.gov/api/v3/events` | none | US government work, public domain | ~10 min | `src/lib/sources/eonet.ts` | Open events only, `days=3` window |
| GDACS | `gdacs.org/gdacsapi/api/events/geteventlist/SEARCH` | none | Free use; EU/UN joint initiative, no explicit commercial clause published — flagged unclear | ~10 min | `src/lib/sources/gdacs.ts` | Excludes earthquakes (USGS covers those with more precision); has shown extended outages this session |
| IODA (Georgia Tech/CAIDA) | `api.ioda.inetintel.cc.gatech.edu/v2/outages/summary` | none | Georgia Tech copyright; public API, commercial terms unclear — flagged | ~10 min | `src/lib/sources/ioda.ts` | Outage-anomaly detection, not confirmed intentional shutdowns; thresholded at `event_cnt >= 5` to suppress background noise |
| CISA KEV | `cisa.gov/.../known_exploited_vulnerabilities.json` | none | US government work, public domain | 30 min | `src/lib/sources/cisakev.ts` | Global feed, no country attribution — surfaced as a ticker layer, not a scored event |
| Frankfurter (ECB rates) | `api.frankfurter.app` | none | MIT-licensed wrapper over ECB reference rates | 5 min | `src/lib/sources/forex.ts` | ECB business days only |
| fawazahmed0/exchange-api | jsDelivr CDN | none | Unlicense (public domain) | 5 min | `src/lib/sources/forex.ts` | RUB/UAH fallback only, ECB doesn't carry them |
| World Bank Indicators | `api.worldbank.org/v2/country/.../indicator/...` | none | CC BY 4.0 | hourly | `src/lib/sources/worldbank.ts` | GDP/population only — standalone ticker, not joined to risk model; see WGI note below for what does NOT work on this same API family |
| ECB SDW, Eurostat, BIS | per-provider | none | Free reuse w/ attribution | 15 min | `src/lib/sources/ecb.ts`, `eurostat.ts`, `bis.ts` | Macro tickers, informational only |
| CFTC Commitments of Traders | cftc.gov reports | none | US government work, public domain | hourly | `src/lib/sources/cftc.ts` | Weekly-published data (Fridays) |
| CoinGecko | `api.coingecko.com` | none | Free-tier terms — non-commercial redistribution restriction flagged | 1 min | `src/lib/sources/coingecko.ts` | Ticker only |
| GitHub Search | `api.github.com/search/repositories` | none (10 req/min unauth) | GitHub ToS | 10 min | `src/lib/sources/github.ts` | Ticker only, not risk-relevant |
| CelesTrak, adsb.lol, OpenSky | per-provider | none | CelesTrak/adsb.lol: unclear commercial terms, flagged. OpenSky: non-commercial research use only without a data agreement | 20s–5 min | `src/lib/sources/celestrak.ts`, `adsblol.ts`, `opensky.ts` | Map overlay layers, opt-in, not part of the risk model |
| Open-Meteo | `api.open-meteo.com` | none | CC BY 4.0 non-commercial; paid plan required above free-tier volume — flagged | 5 min | `src/lib/sources/openmeteo.ts` | 12 fixed monitored capitals, current conditions only, not joined to Climate pillar scoring |
| Finnhub | `finnhub.io` | API key (free tier) | Commercial terms unclear, flagged | on-demand | `src/lib/sources/finnhub.ts` | Optional — country-snapshot stock index only, degrades silently without a key |

## Candidates evaluated this session — not integrated

| Source | Status | Reason |
|---|---|---|
| ReliefWeb | **Blocked** | v1 API decommissioned; v2 requires a registered `appname` (functions as an API key). Human & Social pillar covered via GDELT instead. |
| World Bank Worldwide Governance Indicators (WGI) | **Blocked** | Brief's suggested codes (`CC.EST`, `PV.EST`, control/political-stability/rule-of-law estimates) resolve to an archived data source (`WDI Database Archives`) on the standard Indicators API and return "not found" on live query, despite the indicator existing in WGI source id 3. No working query path found without further investigation — possibly requires the World Bank's separate governance data portal rather than the indicators REST API this app already uses. |
| gpsjam.org | **Blocked** | No documented public endpoint; fetched server-side by their own frontend only. |

## Candidates not yet attempted (roadmap, prioritized)

Grouped by what they'd unlock, highest-value first:

**Supply Chain & Resource Security (currently zero coverage — highest priority gap)**
- IMF PortWatch — port congestion/chokepoint data, public API, needs verification.
- EIA — energy production/consumption, needs an API key (free registration).
- UN Comtrade, WTO API, FAOSTAT — structural trade/food-system context.

**Broader conflict/political coverage**
- ACLED — needs a registered API key. High value (protests/battles/violence with
  fatality counts), but registration is a decision for the account owner, not
  something to sign up for silently on their behalf.
- UCDP — armed-conflict confirmation layer, slower-updating, needs verification.

**Infrastructure & Connectivity depth**
- Cloudflare Radar — needs an API token (free tier). Would meaningfully improve on
  IODA's noisier outage-anomaly signal with named, categorized outage events.
- RIPE Atlas/RIPEstat — independent BGP/DNS/reachability confirmation layer.
- NASA FIRMS — active-fire detections, needs a free `MAP_KEY`. Would deepen the
  Climate & Environment pillar beyond GDACS/EONET's discrete alerts.

**Cyber & Technology (currently the other zero-country-coverage pillar)**
- No clear path to *country-attributed* cyber risk from a free source identified yet.
  CISA KEV (already integrated) is deliberately a global ticker, not a scored event,
  precisely because it has no country dimension to attribute honestly.

**Sanctions**
- OFAC, EU, UK, UN, OpenSanctions — not started. Would feed the Political & Governance
  and Geopolitical & Security pillars (new/lifted sanctions as discrete events).

## Deduplication policy

The brief is explicit: repeated news articles about the same event are not independent
confirmations. Today's dedup is URL-uniqueness only (`events.url` is a hard unique
constraint; `onConflictDoNothing` at insert time) plus a 24h recency filter so a general
RSS feed's rolling backlog doesn't surface as breaking. Cross-source confirmation
(GDELT + a wire headline + a satellite signal counting as *stronger* evidence than five
copies of the same GDELT hit) requires the correlation engine — not implemented, see
`docs/ARCHITECTURE.md` §6.1.
