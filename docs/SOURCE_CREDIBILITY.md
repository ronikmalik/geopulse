# News source credibility

Every RSS outlet wired into `src/lib/sources/rss.ts` was checked against
independent media reliability/bias trackers — mainly [Media Bias/Fact
Check](https://mediabiasfactcheck.com) (MBFC), with
[AllSides](https://www.allsides.com) and [Ad Fontes
Media](https://adfontesmedia.com) as cross-checks where MBFC and AllSides
disagreed. Checked 2026-09-04.

**"Unbiased" is not a real property any single news outlet has.** Every
source below carries some lean per these trackers — that's normal, not
disqualifying. What this app relies on instead:

1. **Diversity** — many countries, a mix of left-center and right-center
   outlets, state-funded and privately-owned, so no single editorial
   lean dominates the feed.
2. **A factual-reporting floor** — sources with a documented pattern of
   failed fact-checks, plagiarism, or undisclosed ownership were removed
   outright, not just noted.
3. **Disclosure** — ownership/funding is listed for every source below,
   including the state-funded public broadcasters (DW, France24, CNA),
   because who pays for a newsroom is relevant context for reading it,
   even when editorial independence is real and well-documented.

## Removed after this review

| Source | Reason |
|---|---|
| MercoPress | MBFC rates it **Questionable** / **Low Credibility** — "poor sourcing techniques that border on plagiarism," Mixed factual reporting. Fails the floor outright. |
| Middle East Eye | MBFC docks its factual rating specifically for **opaque ownership**; independent reporting (HonestReporting and others) alleges its controlling figure has ties to Al-Quds TV, a broadcaster widely identified as Hamas-affiliated. This source would feed directly into Israel-Palestine coverage — a conflict-of-interest risk too large to accept regardless of its otherwise "Mostly Factual" score. |

Neither was replaced with a same-region substitute picked under time
pressure — an honest coverage gap beats backfilling with an unvetted
source. See `src/lib/sources/rss.ts`'s own comments for the same note.

## Kept, with disclosed ownership and rating

| Source | Ownership / funding | MBFC bias | MBFC factual rating | Notes |
|---|---|---|---|---|
| BBC | UK public broadcaster (licence-fee funded, editorially independent) | Least Biased / Center | Very High | Widely used as a reliability benchmark by other trackers. |
| Al Jazeera English | State of Qatar (via Qatari royal family funding) | Left-Center (MBFC) / Neutral (Ad Fontes) — raters disagree | Mixed (MBFC) | MBFC flags "misleading extreme editorial bias that favors Qatar" on Qatar/Gulf-adjacent stories specifically; Ad Fontes rates it neutral/reliable. Kept for its genuinely distinct vantage point on Middle East coverage, disclosed as Qatar-funded. |
| The Guardian | UK, owned by the Scott Trust (non-profit, no controlling shareholder) | Left-Center | High | |
| New York Times | US, publicly traded, Sulzberger family controlling stake | Left-Center | High | Failed fact-checks noted by MBFC were on opinion pieces, not news reporting. |
| NPR | US, member-station public radio (federal/listener/corporate funding mix) | Left-Center | High | |
| CBS News | US, Paramount Skydance | Right-Center | Mostly Factual | MBFC notes a recent rightward editorial shift under new leadership (Bari Weiss) as of this rating. |
| DW (Deutsche Welle) | German federal government (public broadcaster, statutory editorial independence under the Deutsche Welle Act) | — (not separately tracked by MBFC under this exact name) | Good factual/sourcing record per third-party reviews | Disclosed as state-funded; legally protected editorial independence, comparable model to BBC. |
| France 24 | French state, via France Médias Monde (public holding company) | Least Biased | High Credibility | Same state-funded/editorially-independent model as DW. |
| Euronews | Alpac Capital (Portugal investment fund, 88%) + government-linked broadcasters (12%); receives some European Commission subsidy | Left-Center | Mostly Factual | MBFC flags subsidy-linked content as a factor keeping it at Mostly (not High) Factual. |
| CNA (Channel News Asia) | Mediacorp, majority state-owned via Singapore's Temasek | Least Biased | High | Reporters Without Borders flags broader press-freedom/self-censorship pressure in Singapore's media environment generally; CNA's own fact-check record is clean per MBFC. |
| South China Morning Post | Alibaba Group (acquired 2016) | Left-Center | Mixed / Medium Credibility | Post-acquisition editorial shift toward "improving China's image overseas" is documented; softer coverage of Hong Kong/Xinjiang-sensitive topics noted by multiple outside reviewers. Kept for its on-the-ground Hong Kong/China desk, but the weakest-rated source still in the list — read with that in mind. |
| Times of India | Times Group (Sahu Jain family) | Right-Center | Mixed | Four failed fact-checks per MBFC; story selection favors the ruling party. The Hindu (below) is the more reliable India source. |
| The Hindu | The Hindu Group / Kasturi & Sons | Left-Center | Mostly Factual / High Credibility | |
| Times of Israel | Independent (chairman Seth Klarman), ad/subscription/donation funded | Left-Center | High | |
| AllAfrica | AllAfrica Global Media | Least Biased | High | Aggregator distributing wire content from African publishers; largest English-language African news distributor. |
| Premium Times (Nigeria) | Premium Times Services Ltd. (Dapo Olorunyomi) | Left-Center | Mostly Factual | MBFC notes weaker sourcing technique but a clean fact-check record; known for anti-corruption/accountability reporting. |
| Africanews | Owned by Euronews (majority-owned by Media Globe Networks / Naguib Sawiris) | Left-Center | Mostly Factual | |
| Buenos Aires Times | Editorial Perfil SA (Jorge Fontevecchia) | Right-Center | High Credibility | |
| Rio Times | Independent (editor Matthias Camenzind) | Not rated by MBFC/AllSides/Ad Fontes | Not rated | No red flags found in this review, but no independent verification exists either — treat with more caution than the rated sources above. |

## Non-editorial sources (not applicable)

USGS, NASA EONET, GDACS, IODA, and CISA KEV are scientific/institutional
data feeds (seismology, disaster tracking, internet-outage telemetry, a
government vulnerability catalog), not news outlets with editorial
judgment — bias/reliability ratings don't apply the same way. Their
licensing terms are tracked separately in `src/lib/sourceRegistry.ts`.

**GDELT** is an aggregator, not a publisher — it indexes tens of
thousands of outlets globally rather than having its own editorial
stance. Its own documented limitations (see the GDELT Project's blog):
a geographic bias toward event coverage physically proximate to
Western/English-language newsrooms, a US-domestic skew, and roughly
55% field-level accuracy with ~20% data redundancy in its raw event
extraction. This app only uses GDELT's article-search API (headline +
link + snippet, routed through the same keyword classifier as everything
else) — not its pre-extracted event/tone fields — which avoids the
worst of that accuracy problem, but the geographic/language skew still
shapes what shows up in results for the five flashpoint queries.

## Revisiting this

This isn't a one-time check — outlet ownership and editorial direction
change (SCMP's post-Alibaba shift and CBS's recent leadership change are
both examples already reflected above). Worth re-checking every few
months, and immediately if a source starts showing up disproportionately
for one country/category or a reader flags something that looks off.
