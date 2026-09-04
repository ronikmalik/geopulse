import { TELEGRAM_CHANNELS } from "./sources/telegram";

// Display names for the events.source values stored by ingest.ts — every
// event card in the UI shows one of these next to its summary, so a
// reader always knows who's actually making the claim (an RSS outlet, a
// direct sensor feed, or a named Telegram channel with its bias framing
// intact) rather than a neutral-looking headline with no attribution.
const RSS_OUTLET_NAMES: Record<string, string> = {
  "bbc-world": "BBC",
  "guardian-world": "The Guardian",
  "nyt-world": "New York Times",
  "npr-world": "NPR",
  "cbs-world": "CBS News",
  "dw-world": "DW",
  "france24-world": "France 24",
  euronews: "Euronews",
  "cna-world": "CNA",
  "the-hindu": "The Hindu",
  "al-monitor": "Al-Monitor",
  "times-of-israel": "Times of Israel",
  allafrica: "AllAfrica",
  "premium-times-nigeria": "Premium Times (Nigeria)",
  africanews: "Africanews",
  "buenos-aires-times": "Buenos Aires Times",
};

const DIRECT_SOURCE_NAMES: Record<string, string> = {
  gdelt: "GDELT (open-source news aggregator)",
  usgs: "USGS",
  eonet: "NASA EONET",
  gdacs: "GDACS",
  ioda: "IODA (Georgia Tech)",
  firms: "NASA FIRMS (satellite)",
};

// Telegram channel labels already carry their institutional identity and
// bias framing (see docs/TELEGRAM_SOURCES.md "Framing discipline") —
// reused here rather than duplicated, so the UI label and the summary
// text's own prefix can never drift apart.
const TELEGRAM_LABELS: Record<string, string> = Object.fromEntries(
  TELEGRAM_CHANNELS.map((c) => [c.handle, c.label]),
);

export function sourceLabel(source: string): string {
  if (source.startsWith("telegram:")) {
    const handle = source.slice("telegram:".length);
    return TELEGRAM_LABELS[handle] ?? `Telegram (@${handle})`;
  }
  if (source.startsWith("rss:")) {
    const slug = source.slice("rss:".length);
    return RSS_OUTLET_NAMES[slug] ?? slug;
  }
  return DIRECT_SOURCE_NAMES[source] ?? source;
}
