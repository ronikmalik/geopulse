# Beyond RSS: sourcing genuinely live/breaking signal

The RSS/GDELT sources this app started with are fundamentally *published-
article* feeds — even a "breaking" headline has already gone through a
reporter, an editor, and a CMS before it reaches this app, which means an
inherent lag (minutes to hours) and an inherent framing (a written summary
of an event, not the event itself). This doc covers what was investigated
to supplement that with sources closer to "a sensor detected this
happening," what got added, and — just as important — what was checked and
deliberately NOT added, and why.

## Added: NASA FIRMS (satellite thermal-anomaly detection)

`src/lib/sources/firms.ts`, live in the regular ingest cycle. VIIRS
satellite passes detect thermal anomalies (fires, large explosions,
industrial incidents — anything hot enough and large enough to register)
with **~3 hours** latency from satellite overpass to API availability, per
NASA's own stated NRT latency figure — a direct sensor reading, not
something that had to be observed, written up, and published first.

**What it can't tell you, and the code is explicit about this**: FIRMS
detects a thermal anomaly, full stop. The NRT product's own "type" column
(which would distinguish wildfire vs. industrial fire vs. other causes)
isn't populated — this is a NASA/FIRMS product limitation, not something
this app's code failed to parse. A cluster of detections near a conflict
zone is worth surfacing as corroborating signal; it is never asserted as
"a strike happened here." The summary text on every event says this
explicitly.

**Filtering, to avoid drowning real signal in noise**: VIIRS detects
thousands of small fires globally every day (mostly agricultural burning),
so raw detections are grid-clustered (~28km cells) and only clusters with
8+ high-confidence detections and 500+ MW combined radiative power are
surfaced — the same "not every raw signal is reportable" judgment call
already made for IODA's outage counts (`src/lib/sources/ioda.ts`). These
two thresholds are a conservative first guess with no real-world tuning
data behind them yet; revisit once actual ingest data shows what "big"
looks like in practice, the same way IODA's `MIN_REPORTABLE_EVENT_COUNT`
was tuned after observing it drowning out other pillars.

**Setup required**: a free `FIRMS_MAP_KEY` — instant email signup at
https://firms.modaps.eosdis.nasa.gov/api/map_key/, no approval wait. The
source silently no-ops until that env var is set (doesn't fail ingest).

**Licensing**: general NASA open-data policy is public-domain/CC0-
equivalent, but no FIRMS-specific terms page was found stating this in so
many words — tracked as "unclear" in `src/lib/sourceRegistry.ts` rather
than assumed clear, consistent with how every other source here is tracked.

## Investigated and NOT added: ACLED

ACLED (Armed Conflict Location & Event Data) looked like the obvious fit —
geocoded, structured conflict-event data — but two findings killed it after
checking ACLED's own documentation directly (not marketing copy):

1. **The free tier isn't near-real-time.** ACLED splits access into tiers:
   Open (free, no API), Research (free API, but the data is described as
   materially lagged), and Partner/Enterprise (current weekly data, but
   requires a paid licensing agreement). There is no free tier that's both
   API-accessible and current.
2. **The underlying dataset is weekly-batch regardless of tier** — events
   are reviewed and coded roughly a week after occurrence, per ACLED's own
   "Keeping ACLED Data Updated" methodology page. Even the paid tier isn't
   a live stream; it's a faster weekly refresh.

That's the opposite of what this section exists to fix. Paying for
Partner/Enterprise access to get weekly-not-live data that still isn't
"just happened" doesn't solve the actual problem, and ACLED's free-tier
terms separately restrict building a monetizable public product directly
on top of their data without contacting them for a commercial license —
a second, independent reason it doesn't fit this app as-is right now.
Not integrated. Revisit only if a Partner-tier agreement is ever pursued
deliberately, with its own paid-licensing conversation — not as a
free-tier drop-in.

## Telegram OSINT — pursued anyway, with the ToS conflict documented

The accounts that actually publish "just happened" ground reports fastest
in practice (X/Twitter OSINT accounts, Telegram channels used by conflict
monitors) don't have a workable free path the way this app's other sources
do: X's API is paid, and Telegram's own Content Licensing terms restrict
automated access to content beyond "ordinary, legitimate, and intended
use... as its user" — a different, more direct ToS conflict than any other
source in this list, all of which are official public APIs or explicit
syndication features. Initially not pursued for exactly that reason.

As of 2026-09-04, the user made an explicit, informed decision to build it
anyway, accepting that risk. `src/lib/sources/telegram.ts` reads public
channels (never groups or private chats) via Telegram's own no-auth web
preview, deliberately throttled (rotation + spacing, same discipline as the
GDELT fix) as both good practice and risk mitigation given the terms
conflict. The channel list itself isn't guessed — every channel came from
ISW's own published endnote citations in their daily Russia-Ukraine and
Iran assessments, on the reasoning that a well-resourced conflict-analysis
shop's own disclosed sourcing is a defensible starting point. Full channel
list, tiering, and what was deliberately left out: `docs/TELEGRAM_SOURCES.md`.
X/Twitter OSINT remains not pursued — no free API path exists there at all.

## Already live, baseline recording started: military flight tracking

`src/lib/sources/adsblol.ts` already live-tracks military aircraft
worldwide via adsb.lol, surfaced today as a passive opt-in Context Layer
("Military Aircraft Activity" — see `src/lib/dataLayers.ts`), not as a
scored event. Flagging an actual *surge* in tracked military aircraft over
a region, not just showing the raw count, needs a rolling baseline to
compare against ("is this more than usual for this region") — which the
app didn't have. The honest path is the same one already built for country
risk history (`country_state_history` / `src/lib/history.ts`): as of
2026-09-04, a daily `/api/admin/snapshot-flights` cron (`vercel.ts`)
reverse-geocodes every currently-tracked military aircraft's lat/lon to a
country (`src/lib/geoResolve.ts`) and records per-country counts into
`aircraft_count_history` (`src/lib/flightBaseline.ts`). This is
recording only — no anomaly detection yet, because there's no real
baseline yet. Once a few weeks of daily snapshots exist, the next step is
genuine surge detection (e.g. today's count vs. a trailing-N-day average
per country) instead of a threshold guessed with no data behind it.
