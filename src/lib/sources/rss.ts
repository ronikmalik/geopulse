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
  // Asia-Pacific
  {
    name: "cna-world",
    url: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml",
  },
  {
    name: "the-hindu",
    url: "https://www.thehindu.com/news/national/feeder/default.rss",
  },
  // Middle East — Washington DC-based, Arab-American-founded, HIGH
  // credibility/HIGH factual per MBFC, no foreign-agent registration
  // question. Times of Israel gives the Israeli vantage point; this
  // gives the Arab-world one, without Al Jazeera's baggage.
  { name: "al-monitor", url: "https://www.al-monitor.com/rss.xml" },
  { name: "times-of-israel", url: "https://www.timesofisrael.com/feed/" },
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
