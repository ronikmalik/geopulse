import type { Category } from "../categories";
import type { DirectItem } from "./direct";
import { COUNTRY_CENTROIDS } from "../countryCentroids";

// Public-channel scraping via Telegram's own no-auth web preview
// (t.me/s/<channel>) — no bot token, no login, never touches groups or
// private chats. This is a deliberate, documented exception to this
// project's usual "verify the provider's terms first" discipline: read
// docs/TELEGRAM_SOURCES.md before touching this file. Short version —
// Telegram's Content Licensing terms restrict automated access beyond
// "ordinary use... as its user," which this doesn't fit; the user decided
// to proceed anyway with that risk understood. Keep requests light (this
// module rotates through a subset of channels per ingest cycle, same
// spirit as the GDELT fix in ingest.ts) as both good practice and risk
// mitigation.
const TELEGRAM_PREVIEW_BASE = "https://t.me/s";
const REQUEST_TIMEOUT_MS = 10_000;

export interface TelegramChannelConfig {
  handle: string;
  label: string; // shown to the reader, e.g. "Rybar (pro-Russian military channel)"
  country: string; // ISO 3166-1 alpha-2
  category: Category;
}

// See docs/TELEGRAM_SOURCES.md for how this list was built (sourced from
// ISW's own published citations, not guessed) and the reasoning for what
// was deliberately left out.
export const TELEGRAM_CHANNELS: TelegramChannelConfig[] = [
  { handle: "GeneralStaffZSU", label: "Ukraine General Staff (official)", country: "UA", category: "russia-ukraine" },
  { handle: "kpszsu", label: "Ukrainian Air Force (official)", country: "UA", category: "russia-ukraine" },
  { handle: "mod_russia", label: "Russian Ministry of Defense (official)", country: "RU", category: "russia-ukraine" },
  { handle: "dsns_telegram", label: "Ukraine State Emergency Service (official)", country: "UA", category: "natural-disaster" },
  { handle: "rybar", label: "Rybar (pro-Russian military channel, unverified)", country: "RU", category: "russia-ukraine" },
  { handle: "wargonzo", label: "WarGonzo (pro-Russian military channel, unverified)", country: "RU", category: "russia-ukraine" },
  { handle: "iribnews", label: "IRIB — Iran state broadcaster", country: "IR", category: "us-iran" },
  { handle: "farsna", label: "Fars News Agency (Iran state-affiliated)", country: "IR", category: "us-iran" },
  { handle: "presstv", label: "Press TV (Iran state media)", country: "IR", category: "us-iran" },
];

interface TelegramPost {
  id: string; // "<handle>/<messageId>"
  text: string;
  publishedAt: Date;
}

function decodeEntities(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .trim();
}

function parseChannelHtml(html: string): TelegramPost[] {
  const posts: TelegramPost[] = [];
  const blocks = html.split("tgme_widget_message_wrap js-widget_message_wrap");

  for (const block of blocks) {
    const postMatch = block.match(/data-post="([^"]+)"/);
    if (!postMatch) continue;

    const dateMatch = block.match(
      /tgme_widget_message_date"[^>]*href="[^"]*">\s*<time datetime="([^"]+)"/,
    );
    if (!dateMatch) continue;

    const textMatch = block.match(
      /tgme_widget_message_text js-message_text"[^>]*>([\s\S]*?)<\/div>/,
    );
    if (!textMatch) continue; // media-only post (photo/video, no caption) — nothing to classify

    const text = decodeEntities(textMatch[1]);
    if (!text) continue;

    const publishedAt = new Date(dateMatch[1]);
    if (isNaN(publishedAt.getTime())) continue;

    posts.push({ id: postMatch[1], text, publishedAt });
  }

  return posts;
}

async function fetchChannelHtml(handle: string): Promise<string> {
  const res = await fetch(`${TELEGRAM_PREVIEW_BASE}/${handle}`, {
    headers: { "User-Agent": "geopulse-globe/1.0" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Telegram preview fetch failed for ${handle}: ${res.status}`);
  }
  return res.text();
}

// A short excerpt, not the full post — this is a citation pointing at the
// source, the same restraint applied to RSS (headline + link, no full-text
// reproduction) in src/lib/sources/rss.ts.
const EXCERPT_MAX_CHARS = 280;

function toDirectItem(post: TelegramPost, config: TelegramChannelConfig): DirectItem | null {
  const centroid = COUNTRY_CENTROIDS[config.country];
  if (!centroid) return null;

  const excerpt =
    post.text.length > EXCERPT_MAX_CHARS
      ? `${post.text.slice(0, EXCERPT_MAX_CHARS)}…`
      : post.text;

  // See docs/TELEGRAM_SOURCES.md "Framing discipline" — always named,
  // never presented as a neutral wire report.
  const summary = `${config.label}: ${excerpt}`;

  return {
    source: `telegram:${config.handle}`,
    url: `https://t.me/${post.id}`,
    title: summary.length > 120 ? `${summary.slice(0, 117)}...` : summary,
    summary,
    category: config.category,
    location: config.label,
    country: config.country,
    lat: centroid.lat,
    lon: centroid.lon,
    severity: 2,
    publishedAt: post.publishedAt,
  };
}

export async function fetchTelegramChannel(
  config: TelegramChannelConfig,
): Promise<DirectItem[]> {
  const html = await fetchChannelHtml(config.handle);
  const posts = parseChannelHtml(html);
  return posts
    .map((p) => toDirectItem(p, config))
    .filter((item): item is DirectItem => item !== null);
}
