# News source credibility

Every RSS outlet wired into `src/lib/sources/rss.ts` was checked against
independent media reliability/bias trackers — mainly [Media Bias/Fact
Check](https://mediabiasfactcheck.com) (MBFC), with
[AllSides](https://www.allsides.com) and [Ad Fontes
Media](https://adfontesmedia.com) as cross-checks where MBFC and AllSides
disagreed. Two review passes: an initial check (2026-09-04) and a second,
stricter pass the same day after being asked to apply the standard "would
a responsible American third party consider this outlet reliable" —
which surfaced one source (Al Jazeera) that passed the first pass's bar
but not the second.

**"Unbiased" is not a real property any single news outlet has.** Every
source below carries some editorial lean per these trackers — that alone
is normal, not disqualifying. A bias *lean* and a *trust* problem are
different things, and this list draws that line explicitly: sources were
removed for something more concrete than "leans left" or "leans
right" — undisclosed/contested ownership, a documented editorial-
independence failure, or an active government/legal entanglement a
careful reader would reasonably weigh. What's left leans on:

1. **Diversity** — many countries, a mix of left-center and right-center
   outlets, state-funded and privately-owned, so no single editorial
   lean dominates the feed.
2. **A trust floor**, not just a factual-accuracy floor — see "Removed"
   below for the difference.
3. **Disclosure** — ownership/funding is listed for every source kept,
   including the state-funded public broadcasters (DW, France24, CNA),
   because who pays for a newsroom is relevant context even when
   editorial independence is real and legally protected.

## The wire-service gap (checked, not available)

Reuters, AP, and AFP are the outlets working journalists themselves rank
as the trust benchmark — a 2024 Pew survey found 78% of journalists cite
wire services as their most-trusted source for breaking international
news. All three were checked for a usable free public RSS feed:

- **Reuters**: `401 Unauthorized` — feed requires a paid API/syndication
  account now.
- **AP**: `404` — no public feed found at their documented paths.
- **AFP**: has an `rss.xml`, but it serves AFP's own corporate/press
  announcements (e.g. conference recaps), not a news wire — not usable.

This is a real gap in the source list, not one papered over with a
weaker substitute. If a paid Reuters/AP syndication feed is ever added
later, it should be the first thing wired in.

## Known technical gap: France24 (world edition)

`france24-world` is wired into `src/lib/sources/rss.ts` and passes the
credibility review above, but its feed (`https://www.france24.com/en/rss`)
ships malformed XML — an unescaped `>` inside an attribute, which the
`sax`/`xml2js` parser `rss-parser` uses rejects outright (`Attribute
without value`, line 9). Confirmed reproducible directly against the
live feed, not a local artifact. Tried `xml2js: { strict: false }`
(rss-parser passes its `xml2js` option straight through) as a lenient
fallback — it fails differently instead of recovering ("Feed not
recognized as RSS 1 or 2"), so it isn't a real fix. `fetchRssFeed`'s
existing try/catch means this fails soft (0 items that cycle, logged,
no crash) rather than breaking ingestion — same posture as the wire-
service gap above: a real gap, not one worth a fragile workaround. If
France24 ever fixes their feed or publishes an alternate endpoint, this
should be revisited.

## Removed

| Source | Why | Category |
|---|---|---|
| MercoPress | MBFC rates it **Questionable** / **Low Credibility** — "poor sourcing techniques that border on plagiarism." | Factual-accuracy failure |
| Middle East Eye | MBFC docks its factual rating specifically for **opaque ownership**; independent reporting (HonestReporting and others) alleges its controlling figure has ties to Al-Quds TV, a broadcaster widely identified as Hamas-affiliated. Would have fed directly into Israel-Palestine coverage. | Ownership / conflict of interest |
| Al Jazeera | Left-Center/Mixed-to-Neutral on bias trackers (raters disagree) — that alone wouldn't have been disqualifying. What is: AJ+, Al Jazeera's US-facing digital arm, was ordered by the **US Department of Justice in 2020 to register under FARA** (the Foreign Agents Registration Act) over political activity on behalf of Qatar, a bipartisan Congressional group (Cruz, Rubio, Zeldin, and others) has continued pushing for enforcement, and the parent network is Qatari state-funded. Editorial independence is contested by the network's own US legal history, not just by critics' opinion. | Active US legal/regulatory concern |
| South China Morning Post | Alibaba Group-owned since 2016. MBFC and multiple outside reviewers (Lowy Institute, Asia Sentinel) document a post-acquisition editorial mission shift toward "improving China's image overseas," with softer coverage of Hong Kong pro-democracy protests and Xinjiang specifically. MBFC: Left-Center, MIXED factual, MEDIUM credibility. | Ownership / documented editorial shift |
| Times of India | MBFC: Right-Center, **MIXED** factual reporting — four failed fact-checks, story selection favoring the ruling party. The Hindu covers the same country at a meaningfully higher reliability tier and is kept instead. | Factual-accuracy — better same-country alternative exists |
| Rio Times | Not independently rated by MBFC, AllSides, or Ad Fontes at all. No red flags found in this review, but nothing to point to either — under the "would a third party vouch for this" standard, an unrated source can't clear the bar the same way a rated one can. | Unverifiable |

None of these were backfilled with a same-region substitute picked under
time pressure — Al-Monitor (below) is the one deliberate exception,
found specifically because losing both Al Jazeera and Middle East Eye
would have left Middle East coverage entirely one-sided (Israeli-founded
Times of Israel only). Everywhere else, an honest coverage gap beats
backfilling with an unvetted source.

## Kept, with disclosed ownership and rating

| Source | Ownership / funding | MBFC bias | MBFC factual rating | Notes |
|---|---|---|---|---|
| BBC | UK public broadcaster (licence-fee funded, editorially independent) | Least Biased / Center | Very High | Used as a reliability benchmark by other trackers. |
| The Guardian | UK, owned by the Scott Trust (non-profit, no controlling shareholder) | Left-Center | High | |
| New York Times | US, publicly traded, Sulzberger family controlling stake | Left-Center | High | Failed fact-checks MBFC notes were on opinion pieces, not news reporting. |
| NPR | US, member-station public radio (federal/listener/corporate funding mix) | Left-Center | High | |
| CBS News | US, Paramount Skydance | Right-Center | Mostly Factual | MBFC notes a recent rightward editorial shift under new leadership (Bari Weiss) as of this rating. |
| DW (Deutsche Welle) | German federal government (public broadcaster, statutory editorial independence under the Deutsche Welle Act) | Not separately tracked by MBFC under this exact name | Strong factual/sourcing record per third-party reviews | State-funded with legally protected editorial independence — same model as BBC/NPR, a democracy with a free press, not a comparable situation to Al Jazeera's FARA question. |
| France 24 | French state, via France Médias Monde (public holding company) | Least Biased | High Credibility | Same state-funded/editorially-independent model as DW. |
| Euronews | Alpac Capital (Portugal investment fund, 88%) + government-linked broadcasters (12%); receives some European Commission subsidy | Left-Center | Mostly Factual | MBFC flags subsidy-linked content as a factor keeping it at Mostly (not High) Factual. |
| CNA (Channel News Asia) | Mediacorp, majority state-owned via Singapore's Temasek | Least Biased | High | Reporters Without Borders flags broader press-freedom/self-censorship pressure in Singapore's media environment generally; CNA's own fact-check record is clean per MBFC. |
| The Hindu | The Hindu Group / Kasturi & Sons (independent family ownership) | Left-Center | Mostly Factual / High Credibility | One of India's oldest (1878) and most internationally cited papers of record. |
| Al-Monitor | Al Monitor LLC — founded by Arab-American entrepreneur Jamal Daniel, Washington DC-based, partnered with North Base Media | Left-Center | HIGH Credibility / HIGH factual | Added in the second review pass specifically to give Middle East coverage a non-Israeli, Arab-world-sourced vantage point without Al Jazeera's FARA history. |
| Times of Israel | Independent (chairman Seth Klarman, US-based Baupost Group founder), ad/subscription/donation funded | Left-Center | High | |
| AllAfrica | AllAfrica Global Media | Least Biased | High | Largest English-language distributor of African-published news; aggregates from African outlets rather than being a single newsroom. |
| Premium Times (Nigeria) | Premium Times Services Ltd. (Dapo Olorunyomi) | Left-Center | Mostly Factual | MBFC notes weaker sourcing technique but a clean fact-check record; known for anti-corruption/accountability reporting. |
| Africanews | Owned by Euronews (majority-owned by Media Globe Networks / Naguib Sawiris) | Left-Center | Mostly Factual | |
| Buenos Aires Times | Editorial Perfil SA (Jorge Fontevecchia) | Right-Center | High Credibility | |
| RFE/RL | US government, funded via USAGM (US Agency for Global Media); statutorily editorially independent, same legal model as VOA | Least Biased | High Credibility | Broadest single-outlet reach in this list — Russia, Ukraine, the Caucasus, Central Asia, and the Balkans in one feed. Added 2026-09-04 at the user's request to find more disclosed-government-funded outlets in the BBC/DW/France24 mold. |
| Meduza | Independent, non-profit, reader/crowdfunded; based in Riga after Russian authorities designated it an "undesirable organization" | Left | High | In-exile Russian outlet — anti-Kremlin lean is disclosed and expected, the same way Rybar/WarGonzo in the Telegram layer are disclosed as pro-Kremlin. |
| The Moscow Times | Independent, reader-funded; based in Amsterdam after Russian authorities revoked its domestic media registration | Left-Center | High | Same in-exile situation as Meduza. |
| TWZ (The War Zone) | Recurrent Ventures (privately held US digital media company) | Center | High | Defense/military-conflict specialist, not a general-interest outlet. |
| FDD's Long War Journal | Published by the Foundation for Defense of Democracies, a Washington DC think tank | Right-Center | High | Terrorism/insurgency-tracking specialist. |
| Taipei Times | Liberty Times Group (private Taiwanese media company) | Left-Center | Mostly Factual / High Credibility | Disclosed pro-Taiwan-independence editorial lean. Closes a real gap — china-taiwan previously had no dedicated regional outlet. |
| NK News | Korea Risk Group (private, founded by Chad O'Carroll), subscription-funded | Least Biased | High | North Korea specialist. Closes a real gap — north-korea previously had no dedicated outlet, only GDELT's keyword query. |
| Haaretz | Schocken family (75%), Leonid Nevzlin (25%, Russian-Israeli businessman) | Left | High | Israeli-domestic-critical counterweight to Times of Israel — same disclosed-lean logic as Meduza/Moscow Times. |
| ABC News (Australia) | Australian Broadcasting Corporation — public broadcaster, statutorily editorially independent | Left-Center | High | Same disclosed-public-funding/independence model as BBC/DW/France24/RFE/RL. |
| CBC News (Canada) | Canadian Broadcasting Corporation — public broadcaster, statutorily editorially independent | Left-Center | High | Same model as ABC Australia. |

26 sources, spanning North America, Europe, Russia/Ukraine/Central Asia
(now meaningfully deeper via RFE/RL, Meduza, and Moscow Times), the
Middle East (Israeli, Arab-world, and Israeli-critical vantage points),
South/Southeast Asia, Taiwan, North Korea, Australia, Canada, Africa, and
Latin America (Argentina only, after Rio Times's removal and MercoPress's
earlier removal — a real gap; Brazil/wider South America coverage now
depends on the global wire outlets happening to cover it).

## Checked and rejected (2026-09-04 expansion pass)

Looking specifically for outlets specializing in breaking/conflict news
and, per the user's request, more disclosed-government-funded outlets in
the RFE/RL mold. These were checked and did not make it in:

| Source | Why not |
|---|---|
| Kyiv Independent | High credibility per MBFC, but no working RSS feed found at any common path (confirmed 404 after redirect) — an honest gap, not a bias/credibility failure. |
| Focus Taiwan (CNA) | High factual per MBFC, government-funded (Taiwan) and disclosed, but no discoverable RSS feed. |
| Naharnet | Reasonable credibility signal (independent, Center bias, Very High factuality per Ground News) but no MBFC page found and no discoverable RSS feed — couldn't clear either the verification bar or the availability bar. |
| Rudaw | MBFC rates it **Questionable** overall — "promotion of pro-government propaganda" and ownership/funding opacity. Same tier as the already-excluded MercoPress. |
| Institute for the Study of War (understandingwar.org) | The organization researched at the start of this whole Telegram-sourcing effort — but their own CMS explicitly disables RSS ("we disable the RSS feed for performance reasons," per their server headers). Nothing to wire in. |
| Voice of America | Same USAGM funding model as RFE/RL, but the feed is **dead**: every article is dated 2026-03-15 — the exact day USAGM funding was cut — and nothing has published since. An 18-month-stale feed, not a live source. |
| Radio Free Asia | Reportedly still publishing per third-party reporting, but no working RSS feed found at any common or guessed path. |
| Yonhap News Agency | Real value for Korean-peninsula coverage, but a meaningfully weaker trust model than the others here — MBFC notes the South Korean government directly controls Yonhap and appoints its board (not just funds it under statutory independence, the BBC/DW/RFE/RL model), and rates its factual reporting "Mostly Factual" rather than "High" due to weaker sourcing technique. Held back pending an explicit decision rather than folded in quietly. |

## Non-editorial sources (not applicable)

USGS, NASA EONET, GDACS, IODA, and CISA KEV are scientific/institutional
data feeds (seismology, disaster tracking, internet-outage telemetry, a
government vulnerability catalog), not news outlets with editorial
judgment — bias/reliability ratings don't apply the same way. Their
licensing terms are tracked separately in `src/lib/sourceRegistry.ts`.

**GDELT** is an aggregator, not a publisher — it indexes tens of
thousands of outlets globally rather than having its own editorial
stance. Its own documented limitations (per the GDELT Project's blog): a
geographic bias toward event coverage physically proximate to
Western/English-language newsrooms, a US-domestic skew, and roughly 55%
field-level accuracy with ~20% data redundancy in its raw event
extraction. This app only uses GDELT's article-search API (headline +
link + snippet, routed through the same keyword classifier as everything
else) — not its pre-extracted event/tone fields — which avoids the worst
of that accuracy problem, but the geographic/language skew still shapes
what shows up for the five flashpoint queries.

## Revisiting this

This isn't a one-time check — outlet ownership, funding, and legal status
change (SCMP's post-Alibaba shift, CBS's recent leadership change, and
Al Jazeera's FARA history are all examples already reflected above).
Worth re-checking every few months, and immediately if a source starts
showing up disproportionately for one country/category or a reader flags
something that looks off.
