import Parser from "rss-parser";
import type { RawItem } from "./gdelt";

const parser = new Parser({
  timeout: 10_000,
  headers: { "User-Agent": "geopulse-globe/1.0" },
});

// Global-wire baseline plus one real, English-language outlet per
// underserved region. Every source here was checked against independent
// reliability/bias trackers (Media Bias/Fact Check, AllSides, Ad Fontes) —
// see docs/SOURCE_CREDIBILITY.md for the full per-outlet writeup
// (ownership, funding, bias lean, factual-reporting rating, citations)
// and, more importantly, for WHY each removal below was removed — a bias
// *lean* alone isn't disqualifying (every outlet has one), but these
// failed on something more concrete: undisclosed/contested ownership,
// a documented editorial-independence problem, or an active US legal/
// regulatory concern that a careful reader would reasonably weigh:
//   - MercoPress: MBFC rates it "Questionable" / LOW CREDIBILITY — sourcing
//     that "borders on plagiarism."
//   - Middle East Eye: opaque ownership; independent reporting alleges its
//     controlling figure has ties to a Hamas-affiliated broadcaster.
//   - Al Jazeera: Qatari state funding aside, AJ+ (its US-facing arm) was
//     ordered by the DOJ in 2020 to register under FARA (foreign agent
//     disclosure) and a bipartisan Congressional push (Cruz, Rubio, Zeldin
//     among others) has continued pressing the issue — an active US
//     legal/regulatory question, not just a bias-tracker lean.
//   - South China Morning Post: Alibaba-owned since 2016; MBFC and
//     multiple outside reviewers document a post-acquisition editorial
//     shift toward softer coverage of Hong Kong/Xinjiang-sensitive topics.
//   - Times of India: MIXED factual rating from MBFC (four failed fact
//     checks) and story selection favoring the ruling party — The Hindu
//     covers the same country at a meaningfully higher reliability tier.
//   - Rio Times: not independently rated by MBFC/AllSides/Ad Fontes at
//     all — no red flags found, but nothing to point to either.
// Reuters, AP, and AFP — the wire services actually considered the
// trust benchmark by working journalists — were checked and do NOT have
// a usable free public RSS feed anymore (Reuters: 401, AP: 404, AFP's
// feed serves the agency's own corporate press releases, not a news
// wire). That's an honest gap, not something substituted around.
export const RSS_FEEDS: { name: string; url: string }[] = [
  // Global wire / North America
  { name: "bbc-world", url: "http://feeds.bbci.co.uk/news/world/rss.xml" },
  { name: "guardian-world", url: "https://www.theguardian.com/world/rss" },
  {
    name: "nyt-world",
    url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
  },
  { name: "npr-world", url: "https://feeds.npr.org/1004/rss.xml" },
  { name: "cbs-world", url: "https://www.cbsnews.com/latest/rss/world" },
  // Europe
  { name: "dw-world", url: "https://rss.dw.com/xml/rss-en-world" },
  { name: "france24-world", url: "https://www.france24.com/en/rss" },
  {
    name: "euronews",
    url: "https://www.euronews.com/rss?level=theme&name=news",
  },
  // US government-funded (via USAGM), statutorily editorially independent
  // — same disclosed-public-funding model as BBC/DW/France24 above, not
  // comparable to Al Jazeera's FARA history (see SOURCE_CREDIBILITY.md).
  // Broadest single-outlet geographic reach in this list: Russia, Ukraine,
  // the Caucasus, Central Asia, and the Balkans in one feed — exactly the
  // conflict theaters russia-ukraine and political-instability track.
  { name: "rferl", url: "https://www.rferl.org/api/" },
  // Same statutory-independence public-broadcaster model as BBC/DW/
  // France24/RFE/RL above. Checked alongside RFE/RL for more disclosed-
  // government-funded outlets; VOA and Radio Free Asia were also checked
  // and rejected (VOA's feed has been dead since 2025-03-15, the day
  // USAGM funding was cut; RFA has no working RSS feed found) — see
  // SOURCE_CREDIBILITY.md.
  { name: "abc-australia", url: "https://www.abc.net.au/news/feed/51120/rss.xml" },
  { name: "cbc-world", url: "https://www.cbc.ca/webfeed/rss/rss-world" },
  // Independent, in-exile Russian outlets (Russian authorities revoked
  // both organizations' domestic media standing) — an anti-Kremlin
  // editorial lean is disclosed and expected, the same way Rybar/WarGonzo
  // in the Telegram layer are disclosed as pro-Kremlin; having both
  // framings in the pipeline is the point, not a flaw in either.
  { name: "meduza", url: "https://meduza.io/rss/en/all" },
  { name: "moscow-times", url: "https://www.themoscowtimes.com/rss/news" },
  // Defense/conflict specialists — not general-interest outlets, chosen
  // specifically because they cover military/security developments in
  // more operational depth than a general-news wire does.
  { name: "twz", url: "https://www.twz.com/feed" },
  { name: "long-war-journal", url: "https://www.longwarjournal.org/feed" },
  // Asia-Pacific
  {
    name: "cna-world",
    url: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml",
  },
  {
    name: "the-hindu",
    url: "https://www.thehindu.com/news/national/feeder/default.rss",
  },
  // Taiwan-specific — china-taiwan previously had no dedicated regional
  // outlet (cna-world above is Singapore's Channel News Asia, general
  // Asia-Pacific, not Taiwan-focused). Disclosed pro-Taiwan-independence
  // editorial lean per MBFC.
  { name: "taipei-times", url: "https://www.taipeitimes.com/xml/index.rss" },
  // North Korea-specific — north-korea previously had no dedicated outlet
  // at all, only GDELT's keyword query.
  { name: "nknews", url: "https://www.nknews.org/feed" },
  // Asia-Pacific specialist — USAGM-funded (RFE/RL's sister outlet, same
  // statutory-editorial-independence model), High credibility/High factual
  // per MBFC. A prior pass (see SOURCE_CREDIBILITY.md's "checked and
  // rejected" table) found no working feed; the real one lives behind a
  // redirect at this path, found during the 2026-09-04 ISW-sourcing pass —
  // corrected there, not a re-litigation of that decision.
  { name: "rfa", url: "https://www.rfa.org/arc/outboundfeeds/english/rss/" },
  // South Korea's national wire service — real value for Korean-peninsula
  // coverage, a recurring ISW Korean Peninsula Update citation. Included
  // with a disclosed caveat: MBFC notes the SK government directly
  // controls Yonhap and appoints its board (not just funds it under
  // statutory independence, the BBC/DW/RFE/RL model here), rating it
  // "Mostly Factual" rather than "High." Same "state-linked, disclosed,
  // included anyway" precedent already used for Iran's IRIB/Fars/Press TV
  // and Russia's mod_russia in the Telegram layer — held back in an
  // earlier pass pending this explicit call; see SOURCE_CREDIBILITY.md.
  { name: "yonhap", url: "https://en.yna.co.kr/RSS/news.xml" },
  // Middle East — Washington DC-based, Arab-American-founded, HIGH
  // credibility/HIGH factual per MBFC, no foreign-agent registration
  // question. Times of Israel gives the Israeli vantage point; this
  // gives the Arab-world one, without Al Jazeera's baggage.
  { name: "al-monitor", url: "https://www.al-monitor.com/rss.xml" },
  { name: "times-of-israel", url: "https://www.timesofisrael.com/feed/" },
  // Israeli-domestic-critical counterweight to Times of Israel — same
  // "disclosed lean, still high factual reporting" logic as Meduza/Moscow
  // Times above. Ownership includes a 25% stake held by Leonid Nevzlin
  // (Russian-Israeli businessman) — disclosed in SOURCE_CREDIBILITY.md.
  { name: "haaretz", url: "https://www.haaretz.com/srv/haaretz-latest-headlines" },
  // Africa
  {
    name: "allafrica",
    url: "https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf",
  },
  { name: "premium-times-nigeria", url: "https://www.premiumtimesng.com/feed" },
  { name: "africanews", url: "https://www.africanews.com/feed/rss" },
  // Latin America
  { name: "buenos-aires-times", url: "https://www.batimes.com.ar/feed" },
];

export async function fetchRssFeed(feed: {
  name: string;
  url: string;
}): Promise<RawItem[]> {
  try {
    const parsed = await parser.parseURL(feed.url);
    return (parsed.items ?? [])
      .filter((item) => item.link && item.title)
      .map((item) => ({
        source: `rss:${feed.name}`,
        url: item.link!,
        title: item.title!,
        snippet: (item.contentSnippet ?? "").slice(0, 400),
        publishedAt: item.isoDate ? new Date(item.isoDate) : new Date(),
      }));
  } catch (err) {
    console.error(`RSS fetch failed for ${feed.name}:`, err);
    return [];
  }
}

export async function fetchAllRssFeeds(): Promise<RawItem[]> {
  const results = await Promise.all(RSS_FEEDS.map(fetchRssFeed));
  return results.flat();
}
