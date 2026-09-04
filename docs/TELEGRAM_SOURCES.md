# Telegram channel sourcing

## Why this exists, and the terms-of-service call already made

Telegram's own Content Licensing terms (`telegram.org/tos/content-licensing`) state:
"Access to user-generated content for any purpose other than ordinary,
legitimate, and intended use of the Telegram platform as its user is
prohibited." An automated ingest cron reading public channels doesn't fit
that description — this is not a gray area the way "commercial use:
unclear" is for some other sources in `API_SOURCES.md`. The user explicitly
decided to proceed anyway, accepting that risk, after this was laid out
plainly. This file exists so that decision — and its reasoning — stays
documented and auditable rather than silently baked into code, the same
discipline this project applies everywhere else (see `SOURCE_CREDIBILITY.md`,
the ACLED writeup in `OSINT_SOURCES.md`).

**What mitigates the risk in practice:** only public channels are read
(never groups, private chats, or anything requiring login), through
Telegram's own public web-preview feature (`t.me/s/<channel>`, no API key,
no bot, no account) rather than the Bot/MTProto APIs, and polling is
deliberately light (see `src/lib/sources/telegram.ts` for the actual
cadence/rotation — same spirit as the GDELT rotation fix, both to be a
good network citizen and to reduce exposure).

## How the channel list was built

Every channel below came from ISW's own published endnote citations in two
recent daily reports — not guessed, not searched-for independently:
- Russian Offensive Campaign Assessment, Sept 3 2026
  (`understandingwar.org/research/russia-ukraine/...`)
- Iran Update, Sept 3 2026 (`understandingwar.org/research/middle-east/...`)

ISW/CTP's own methodology statement (their public FAQ) says they rely on
"Russian, Ukrainian, and Western reporting and social media" with "all
sources used... provided in the endnotes of each update" — these channels
are literally what a well-resourced conflict-analysis shop already relies
on for this exact purpose. That's the actual justification for this list,
not "these seemed popular."

## Tier 1 — shipped in v1

Chosen for having an unambiguous institutional identity (so attribution in
the UI can name a real actor, not "some Telegram channel") and for being
channels ISW's own citations lean on repeatedly, not once.

| Channel | Institution | Country | Category | Note |
|---|---|---|---|---|
| `GeneralStaffZSU` | Ukraine General Staff (official) | UA | russia-ukraine | Government/military primary source |
| `kpszsu` | Ukrainian Air Force (official) | UA | russia-ukraine | Government/military primary source |
| `mod_russia` | Russian Ministry of Defense (official) | RU | russia-ukraine | Government/military primary source — a combatant's own claims about itself, framed accordingly |
| `dsns_telegram` | Ukraine State Emergency Service (official) | UA | natural-disaster | Civil-defense/casualty/strike-damage alerts — closest thing here to GDACS-style official hazard alerts |
| `rybar` | Rybar — Russian military-affiliated analyst channel, ~1M+ subscribers, run by a former Russian MoD press officer | RU | russia-ukraine | **Not neutral.** Pro-Russian framing; ISW itself cites it constantly as a primary claims source, always attributed, never treated as fact |
| `wargonzo` | WarGonzo — Russian military-affiliated analyst channel | RU | russia-ukraine | Same caveat as Rybar |
| `iribnews` | IRIB (Iran state broadcaster) | IR | us-iran | State media — Iran's own framing of events |
| `farsna` | Fars News Agency (Iran state-affiliated) | IR | us-iran | State-affiliated media |
| `presstv` | Press TV (Iran state media, English-language) | IR | us-iran | State media |

Ukrainian regional administration channels (`chernigivskaODA`,
`dnipropetrovskaODA`, `khmelnytskaODA`, `kyivoda`, `odeskaODA` in ISW's
citations) were investigated but **not included in v1**: they're genuine
official sources, but wiring 5+ additional oblast-specific channels with
their own per-region lat/lon (rather than the country centroid every other
source here uses) is real additional scope — flagged as the natural next
expansion, not skipped silently.

## Explicitly not included, and why

- `zvizdecmanhustu` (Kostyantyn Mashovets, Ukrainian military observer),
  `severnnyi`, `epoddubny`, `rug_international`, `grvZapad`,
  `notes_veterans`, `z_arhiv`, `creamy_caprice`, `army_3heavy`, `ZS42MSD`,
  `mykola_lukashuk`, `vilkul`, `tkachenkotymur`, `serhii_flash`, `uvkkursk`
  — all appeared in ISW's citations at least once, but each needs its own
  credibility read (personal analyst account vs. anonymous aggregator vs.
  raw footage reposter) before inclusion, the same bar `SOURCE_CREDIBILITY.md`
  holds RSS outlets to. Candidates for a deliberate v2 pass, not v1.
- `rucriminalinfo_2` ("Russian criminal info") and `dosye_shpiona` ("spy
  dossier") — appeared in ISW's citations but read as tabloid/sensational
  by name alone; excluded pending an actual look at their content, not
  assumed safe just because ISW cited them once.
- `aishab_alkahf` (an Iranian-backed Iraqi militia channel, cited once in
  the Iran Update) — a combatant militia's own channel is a materially
  different credibility category from a state broadcaster; excluded from
  v1 pending a specific decision on whether militia self-reporting belongs
  in this product at all.

## Translation

Six of the nine channels post in Ukrainian, Russian, or Farsi. Verified
before implementing (2026-09-04) that no free/keyless option actually
works: the unofficial Google Translate endpoint is explicitly disallowed
in Google's own `robots.txt` (`Disallow: /translate_a/`) and its server
live-rejected an automated request as bot traffic during testing; MyMemory
(free, keyless) returned literal garbage — confirmed at the raw-byte
level, not a display bug — for both a Ukrainian and a Farsi test string;
the public LibreTranslate instance now requires a paid key, and its free
community mirrors were down or unreachable. DeepL was ruled out separately
— it doesn't support Farsi at all.

`src/lib/translate.ts` uses the Cloud Translation API v2 ("Basic") via a
simple API key (`GOOGLE_TRANSLATE_API_KEY`) — no OAuth/service account.
Same soft-no-op pattern as `FIRMS_MAP_KEY`: translation is skipped
(original-language text stored as-is) until the key is set, so this
shipped without waiting on it. Every channel's excerpts are translated in
one batched request per fetch, not one call per post. A translated
summary is explicitly marked "[translated from Ukrainian]" (etc.) rather
than presented as the channel's own English phrasing.

## Framing discipline

Every Telegram-derived event's summary is prefixed with the channel's
institutional identity (e.g. "Rybar (pro-Russian military channel):" —
see `src/lib/sources/telegram.ts`) rather than presented as a neutral wire
report. This is the same principle ISW itself applies: a milblogger's claim
is citable evidence, never asserted as established fact on its own.
