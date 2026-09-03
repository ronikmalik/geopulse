import Parser from "rss-parser";
import type { RawItem } from "./gdelt";

const parser = new Parser({
  timeout: 10_000,
  headers: { "User-Agent": "geopulse-globe/1.0" },
});

export const RSS_FEEDS: { name: string; url: string }[] = [
  { name: "bbc-world", url: "http://feeds.bbci.co.uk/news/world/rss.xml" },
  { name: "al-jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { name: "guardian-world", url: "https://www.theguardian.com/world/rss" },
  {
    name: "nyt-world",
    url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
  },
  { name: "npr-world", url: "https://feeds.npr.org/1004/rss.xml" },
  { name: "dw-world", url: "https://rss.dw.com/xml/rss-en-world" },
  { name: "france24-world", url: "https://www.france24.com/en/rss" },
  {
    name: "cna-world",
    url: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml",
  },
  { name: "cbs-world", url: "https://www.cbsnews.com/latest/rss/world" },
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
