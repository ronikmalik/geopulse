# Source modules

Most files here are wired into `src/lib/ingest.ts` and feed the live `events`
table: `gdelt.ts`, `rss.ts`, `usgs.ts`, `eonet.ts`, `gdacs.ts`, `ioda.ts`,
`firms.ts`, `telegram.ts`. Each event category maps to one of the eight risk
pillars — see `src/lib/pillars.ts` and `docs/ROADMAP.md`.

**`telegram.ts`** is a deliberate exception to this project's usual sourcing
bar: Telegram's own terms restrict the kind of automated access it does. The
user made that call explicitly, with the tradeoff understood — see
`docs/TELEGRAM_SOURCES.md` for the full reasoning, the channel list (sourced
from ISW's own published citations, not guessed), and what was deliberately
left out.

**`firms.ts`** (NASA FIRMS/VIIRS satellite thermal-anomaly detection) is the
one genuinely "just happened, not reported-and-written-up" signal in this
list — a direct sensor reading (~3h satellite-to-API latency) rather than a
published article. Requires a free `FIRMS_MAP_KEY` (email signup, no
approval wait — https://firms.modaps.eosdis.nasa.gov/api/map_key/); the
source no-ops (returns nothing, doesn't error) if that env var isn't set.
See the file's own header comment for what this signal can and can't tell
you (a thermal anomaly, not a confirmed cause) and `docs/OSINT_SOURCES.md`
for the fuller writeup, including why ACLED was investigated and NOT
integrated despite fitting the same brief.

The following modules are **standalone and intentionally not integrated**
into the events table: `openmeteo.ts`, `adsblol.ts`, `opensky.ts`,
`worldbank.ts`, `cisakev.ts`, `forex.ts`, `cftc.ts`. Each exports a working,
live-verified fetch function returning normalized data, but none are called
from `ingest.ts`. Live-tracked flights/weather, structural indicators
(GDP/population), and `cisakev.ts` (CISA's vulnerability catalog has no
country attribution at all) don't fit the "point event on the globe" model
the `events` table and feed use; they're instead surfaced as opt-in Context
Layers (`/api/layers/*`) — see `src/lib/dataLayers.ts`.

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

**Crypto markets, trending GitHub repos, generic satellite tracking
(CelesTrak), and Eurozone/BIS macro indicators (ECB, Eurostat, BIS) were
removed** — they didn't feed any of the eight risk pillars and were scope
creep from an earlier, broader "everything dashboard" phase. See
`src/lib/dataLayers.ts` for the reasoning.
