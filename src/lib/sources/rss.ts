import Parser from "rss-parser";
import type { RawItem } from "./gdelt";

const parser = new Parser({
  timeout: 10_000,
  headers: { "User-Agent": "geopulse-globe/1.0" },
});

// Global-wire baseline (unchanged) plus one real, English-language outlet
// per underserved region — added because the original list leaned heavily
// Anglo/European and left large swaths of the world (Africa, Latin
// America, South Asia beyond wire coverage) with near-zero direct
// signal. Every URL below was verified live (HTTP 200 + a real <rss>/
// <feed> root) before being added — a guessed feed URL fails silently
// (fetchRssFeed's catch just returns []), which reads as "this region is
// quiet" when it's actually "this region was never actually being
// checked." A few regions (East Africa specifically, NHK World's actual
// feed URL, Arab News) were tried and dropped rather than forced in —
// they either 403'd (bot protection) or 404'd and no working URL was
// found; better to leave a gap honestly than wire up a dead feed.
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
  { name: "middle-east-eye", url: "https://www.middleeasteye.net/rss" },
  // Africa
  {
    name: "allafrica",
    url: "https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf",
  },
  { name: "premium-times-nigeria", url: "https://www.premiumtimesng.com/feed" },
  { name: "africanews", url: "https://www.africanews.com/feed/rss" },
  // Latin America
  { name: "mercopress", url: "https://en.mercopress.com/rss/" },
  { name: "buenos-aires-times", url: "https://www.batimes.com.ar/feed" },
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
