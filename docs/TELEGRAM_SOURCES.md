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

## v2 (2026-09-04) — broader multi-report, multi-theater pass

v1 above was built from a single day's citations in two reports. The user
asked for a deeper pass: sample many more ISW/CTP reports spread across
months, not just one snapshot, and check theaters beyond Russia-Ukraine and
Iran. Three parallel research passes were run:

- **Russia-Ukraine**: 7 Russian Offensive Campaign Assessment reports spread
  Dec 2025 – Sep 2026 (10-month spread), plus 1 Russian Occupation Update.
- **Iran/Middle East**: 4 Iran Update reports spread across the actual run
  of the series (started June 1 2026 as "Special Report" during the
  Israel-Hezbollah/Iran escalation, became a daily "Iran Update" once the
  US-Iran war began ~July 12) through Aug 27 2026.
- **China-Taiwan / Korea / other theaters**: sampled China-Taiwan Weekly
  Update (AEI+ISW) and Korean Peninsula Update (AEI+ISW) reports across
  2025–2026, and confirmed Israel-Gaza has no separate ISW/CTP product —
  CTP-ISW folded that coverage into the Iran Update in Feb 2025.

### Tier 1 additions shipped in v2

Same bar as v1 — unambiguous institutional identity, cited repeatedly
across the sample, not a personal/analyst account:

| Channel | Institution | Country | Note |
|---|---|---|---|
| `DIUkraine` | Ukrainian Defense Intelligence (official) | UA | Cited 3 of 8 sampled reports |
| `Joint_Forces_Task_Force` | Ukrainian Joint Forces (official military) | UA | Cited 3 of 8 |
| `V_Zelenskiy_official` | Zelensky's official channel | UA | Head of state, official |
| `medvedev_telegram` | Dmitry Medvedev, Deputy Chair of Russia's Security Council (official) | RU | Senior official, not a milblogger |
| `defapress_ir` | Defa Press — Iranian Defense Ministry's own press organ | IR | Cited 3 of 4 Iran Update reports sampled — high frequency |
| `sepah_pasdaran` | IRGC (official) | IR | A combatant force's own official channel, same framing precedent as `mod_russia` |
| `TasnimNewsAgency` | Tasnim News, IRGC-affiliated wire | IR | Same tier as `farsna`, already shipped in v1. ISW's citation used the handle `Tasnimnews`, which now redirects — verified the live handle directly against the channel's Persian-language title before shipping. |
| `mehrnews` | Mehr News Agency, semi-official Iranian state media | IR | Cited 2 of 4 |
| `Nournews_ir` | Nour News, linked to Iran's Supreme National Security Council | IR | Cited 2 of 4 |
| `army21ye` | Houthi Armed Forces spokesperson channel (official) | YE | A combatant's own official spokesperson channel — same "framed as their own claims, not fact" precedent as `mod_russia`. First Yemen-front source in the product. |

`army21ye` posts in Arabic — added `ar: "Arabic"` to `LANGUAGE_NAMES` in
`telegram.ts` for the translation-note label; `translateBatch` already
accepts an arbitrary ISO 639-1 source language, no other code change
needed.

### Tier 2 — candidates found, deliberately NOT shipped, pending individual review

Same discipline as v1's Tier 2: each of these needs its own credibility
read (personal analyst vs. propagandist vs. legitimate independent outlet)
before inclusion, not blanket-added just because ISW cites them.

**Russian/Ukrainian milbloggers and investigative outlets** (all cited
2-3 times across the 8-report sample, i.e. not one-offs):
`dva_majors` (prominent Russian milblogger duo), `boris_rozhin` ("Colonel
Cassad," major Russian milblogger), `sashakots` (Alexander Kots,
Komsomolskaya Pravda war correspondent), `SolovievLive` (Vladimir Solovyov
— Russia's most prominent state-TV propagandist; flagging this one
specifically as a *higher* bar than the milbloggers, given his role, not a
lower one), `astrapress` and `vottaktv` (independent Russian/Belarusian
investigative outlets — read as meaningfully *more* credible than the
milbloggers on the same list, worth a faster follow-up look), `RVvoenkor`
(Russian military-correspondent aggregator).

**Belarus state media** (new angle, only surfaced via the Occupation
Update): `pul_1`, `belta_telegramm`.

**Occupation-administration officials** (Russian-installed authorities in
occupied Ukrainian territory — `PushilinDenis` [DNR], `BalitskyEV`
[Zaporizhzhia], `SALDO_VGA`/`VGA_Kherson` [Kherson], `razvozhaev`
[Sevastopol], `glava_lnr_info` [LNR]): held back not for a credibility
reason (they're genuinely official, same category as `mod_russia`) but
because whether the product should carry Russian-installed occupation
administrations' claims — and how to frame that distinctly from claims
about internationally-recognized Ukrainian territory — is a real editorial
call, not a sourcing one. Flagging for a deliberate decision, not slipping
it in.

**Lebanon front** (Hezbollah-IDF clashes; no dedicated Telegram source
existed for this front before this pass): `mmirleb` (heavily cited —
7+ citations in a single Iran Update report — reads as a real-time
south-Lebanon monitoring/OSINT account, not obviously Hezbollah's own
channel), `sameralhajali` (Lebanese, cited 80+ times in rapid sequence in
one report for real-time strike documentation), `MTVLebanoNews` (Lebanese
mainstream broadcaster), `bintjbeilnews` (hyperlocal south-Lebanon town
news).

**Israel-side analysts**: `BenTzionM`, `moriahdoron` — Israeli
journalists/analysts cited for IDF positioning and Iranian missile/drone
reconstitution reporting.

**Iran analyst**: `InstituteTehran` — cited once in nuclear-threshold
debate context.

**Already-known-excluded list, frequency check**: `severnnyi`,
`creamy_caprice`, and `grvZapad` (each cited 3 of 8 in this pass — meaning
v1's exclusion was NOT because they're one-off citations; they're genuinely
recurring, just still needing the individual read v1 already flagged) and
the Ukrainian oblast admin channels collectively appear often. `epoddubny`,
`mykola_lukashuk`, `vilkul`, `tkachenkotymur`, `ZS42MSD`, `army_3heavy`
were not seen in this broader sample — v1's inclusion of them may have been
a one-off from the single day it was built from.

`ElamAlmoqawama` (Islamic Resistance in Iraq's own channel, v1's flagged
militia-self-reporting case) reappeared again in August — confirms it's a
recurring ISW citation, not a one-off, but the underlying policy question
(does militia self-reporting belong in this product at all) is unchanged
and still unresolved. No new distinct Iraqi militia channel was found.

### Explicitly excluded for cause (not just "needs review")

- **`rusich_army`** — the Telegram channel of Rusich, a Russian
  paramilitary unit with documented neo-Nazi affiliations and war-crimes
  allegations. ISW cites it the same way it cites any
  milblogger (as a claims source), but this is a materially different
  ethics category from "unverified pro-Russian analyst" — closer to the
  `aishab_alkahf` militia-channel case, but with an even clearer reason to
  stay out. Not a candidate for a future pass; excluded on the merits.

### Non-Telegram sources surfaced (see also API_SOURCES.md / a future RSS pass)

- `x.com/CENTCOM` — official US Central Command account, cited constantly
  in Iran Update for US-side military claims. Not Telegram; would need X/
  Twitter ingestion GeoPulse doesn't have.
- `shafaq.com` — Iraqi/Kurdish news agency, cited repeatedly for Iraqi
  political/security developments tied to Iranian-backed militia
  influence. A real RSS gap (GeoPulse has no Iraq-specific source).
  Candidate for a `SOURCE_CREDIBILITY.md`-style vetting pass.
- Israeli military correspondents on X (`manniefabian`, `BarakRavid`,
  `idfonline`) and Yemen/Houthi analyst `BashaReport` on X — same
  "needs X/Twitter ingestion" gap.
- China-Taiwan and Korea theaters lean far more on named X/Twitter
  accounts than Telegram (e.g. Taiwan's `@MoNDefense`) — essentially zero
  Telegram citations in either theater's sample. RFA, Focus Taiwan, KCNA
  Watch (kcnawatch.org, an NK News-run KCNA/Rodong Sinmun mirror), Yonhap,
  and Chosun Ilbo were the recurring non-Telegram sources — see
  `API_SOURCES.md`/`SOURCE_CREDIBILITY.md` for whether these get wired in
  as RSS feeds.
- **Structural gap worth naming plainly**: GeoPulse has zero X/Twitter
  ingestion, and this pass found that gap costs more coverage on the
  China-Taiwan and Korea theaters specifically than on Russia-Ukraine/Iran,
  which are comparatively Telegram-heavy. Not something a few more RSS
  feeds fixes — a real, structural limitation, not a rounding error.

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

Activated 2026-09-04 with a real GCP project (billing enabled — the free
trial was already used up on this account, so Translation isn't in the
always-free tier; a real payment method is on file). Given that,
`src/lib/translationUsage.ts` enforces a hard 499,000 characters/month
ceiling — 1,000 under Google's actual 500,000/month free allowance, on
purpose — tracked per UTC day in a `translation_usage` table (state has
to be durable across serverless invocations, not an in-memory counter
that resets every cold start) so this can never actually trigger billing.
The daily allowance is adaptive: whatever's left in the monthly cap,
divided by however many days remain, recalculated on every check — a
light day's unused quota rolls into the rest of the month rather than
being wasted, while the 499,000 ceiling is still checked independently
of the daily math so rounding can't cause an overage. `translateBatch`
skips translation (same fallback as no key configured) if the batch
would exceed either the day's share or the hard monthly cap.

## Breaking-only filter

Early versions stored every post from every fetched channel — which, given
how frequently these channels post (casualty tallies, procurement updates,
morale pieces, routine statements), made this a raw channel mirror rather
than a breaking-news layer. The user flagged exactly this: "it seems like we
are using all of the telegram stuff, like all of it."

`fetchTelegramChannel` (`src/lib/sources/telegram.ts`) now reuses
`classify.ts`'s `assessIncidentSeverity` — the same BENIGN/ONGOING-coverage
suppression and escalation-verb scoring the rest of the feed uses — but at a
stricter floor (`TELEGRAM_MIN_SEVERITY = 3`, vs. the general feed's `2`).
Mild-only language (warnings, sanctions, "tension," protests) is routine
channel chatter, not what this layer is for; a post only survives if it
reads as an actual incident — a strike, a capture, territory reclaimed, a
drone shot down, casualties, an evacuation — not just topical proximity to
a conflict. A post can only be scored in English, so a non-English channel's
posts are dropped outright (not stored unfiltered) on any cycle where
translation didn't succeed — see `canAssess()`.

## Framing discipline

Every Telegram-derived event's summary is prefixed with the channel's
institutional identity (e.g. "Rybar (pro-Russian military channel):" —
see `src/lib/sources/telegram.ts`) rather than presented as a neutral wire
report. This is the same principle ISW itself applies: a milblogger's claim
is citable evidence, never asserted as established fact on its own.
