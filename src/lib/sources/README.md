# Source modules

Most files here are wired into `src/lib/ingest.ts` and feed the live `events`
table: `gdelt.ts`, `rss.ts`, `usgs.ts`, `eonet.ts`, `gdacs.ts`, `ioda.ts`.
Each event category maps to one of the eight risk pillars — see
`src/lib/pillars.ts` and `docs/ROADMAP.md`.

The following modules are **standalone and intentionally not integrated**
into the events table: `openmeteo.ts`, `celestrak.ts`, `adsblol.ts`,
`coingecko.ts`, `worldbank.ts`, `eurostat.ts`, `ecb.ts`, `bis.ts`,
`github.ts`, `cisakev.ts`. Each exports a working, live-verified fetch
function returning normalized data, but none are called from `ingest.ts`.
Most (prices, indicators, live-tracked flights/orbits, and `cisakev.ts` —
CISA's vulnerability catalog has no country attribution at all) don't fit
the "point event on the globe" model the `events` table and feed use;
`cisakev.ts` is instead surfaced as the "Cyber & Technology" ticker layer
(`/api/layers/cyber`), the same treatment as `github.ts`/`coingecko.ts`.

Every integrated source's licensing/commercial-use terms are tracked in
`src/lib/sourceRegistry.ts` — check there (and the provider's actual terms)
before relying on any of this for something with real commercial stakes.

**ReliefWeb was investigated and skipped**: as of this writing its v1 API is
decommissioned and v2 requires an approved `appname` (effectively an API key
that has to be requested from ReliefWeb — not the no-key public access this
app otherwise sticks to). The "humanitarian" category is covered instead by
a GDELT text-search query (`famine`, `displacement`, `humanitarian crisis`,
disease outbreaks) — see `src/lib/categories.ts`. Revisit ReliefWeb if an
appname is ever registered; its structured disaster/report data would be a
real upgrade over GDELT's free-text search for the Human & Social pillar.

`gpsjam.org` (GPS interference) was investigated but skipped — its data feed
is fetched server-side by their own app and isn't exposed at a documented
public URL, so there's nothing safe to build against yet.
