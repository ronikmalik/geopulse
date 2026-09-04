import Parser from "rss-parser";
import type { RawItem } from "./gdelt";

const parser = new Parser({
  timeout: 10_000,
  headers: { "User-Agent": "geopulse-globe/1.0" },
});

// Global-wire baseline plus one real, English-language outlet per
// underserved region. Every source here was checked against independent
// reliability/bias trackers (Media Bias/Fact Check, AllSides, Ad Fontes)
// before being kept — see docs/SOURCE_CREDIBILITY.md for the full
// per-outlet writeup (ownership, funding, bias lean, factual-reporting
// rating, citations). Two candidates that made it into an earlier version
// of this list failed that check and were removed:
//   - MercoPress: MBFC rates it "Questionable" / LOW CREDIBILITY, citing
//     poor sourcing that "borders on plagiarism."
//   - Middle East Eye: MBFC docks its factual rating specifically for
//     opaque ownership; independent reporting alleges its owner has ties
//     to a Hamas-affiliated broadcaster. For a source that would directly
//     feed Israel-Palestine coverage, that's disqualifying regardless of
//     its Mostly-Factual score.
// "Unbiased" isn't a real property any single outlet has — every source
// here still carries SOME lean per these trackers. The mitigation is
// diversity (many countries, both left-center and right-center outlets,
// state-funded and independent) plus disclosure (docs/SOURCE_CREDIBILITY.md),
// not a false claim that any one of these is neutral.
export const RSS_FEEDS: { name: string; url: string }[] = [
  // Global wire / North America
  { name: "bbc-world", url: "http://feeds.bbci.co.uk/news/world/rss.xml" },
  { name: "al-jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
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
  { name: "scmp", url: "https://www.scmp.com/rss/91/feed" },
  {
    name: "times-of-india",
    url: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms",
  },
  {
    name: "the-hindu",
    url: "https://www.thehindu.com/news/national/feeder/default.rss",
  },
  // Middle East
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
  // Not independently rated by any major fact-checking org (no red flags
  // found either) — disclosed as such in docs/SOURCE_CREDIBILITY.md
  // rather than presented as equivalently vetted to the rated sources above.
  { name: "rio-times", url: "https://riotimesonline.com/feed/" },
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
