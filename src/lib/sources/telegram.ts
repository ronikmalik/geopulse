import type { Category } from "../categories";
import type { DirectItem } from "./direct";
import { COUNTRY_CENTROIDS } from "../countryCentroids";
import { translateBatch } from "../translate";

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
  language: string; // ISO 639-1 source language, or "en" to skip translation
}

// See docs/TELEGRAM_SOURCES.md for how this list was built (sourced from
// ISW's own published citations, not guessed) and the reasoning for what
// was deliberately left out.
export const TELEGRAM_CHANNELS: TelegramChannelConfig[] = [
  { handle: "GeneralStaffZSU", label: "Ukraine General Staff (official)", country: "UA", category: "russia-ukraine", language: "uk" },
  { handle: "kpszsu", label: "Ukrainian Air Force (official)", country: "UA", category: "russia-ukraine", language: "uk" },
  { handle: "mod_russia", label: "Russian Ministry of Defense (official)", country: "RU", category: "russia-ukraine", language: "ru" },
  { handle: "dsns_telegram", label: "Ukraine State Emergency Service (official)", country: "UA", category: "natural-disaster", language: "uk" },
  { handle: "rybar", label: "Rybar (pro-Russian military channel, unverified)", country: "RU", category: "russia-ukraine", language: "ru" },
  { handle: "wargonzo", label: "WarGonzo (pro-Russian military channel, unverified)", country: "RU", category: "russia-ukraine", language: "ru" },
  { handle: "iribnews", label: "IRIB — Iran state broadcaster", country: "IR", category: "us-iran", language: "fa" },
  { handle: "farsna", label: "Fars News Agency (Iran state-affiliated)", country: "IR", category: "us-iran", language: "fa" },
  { handle: "presstv", label: "Press TV (Iran state media)", country: "IR", category: "us-iran", language: "en" },
];

interface TelegramPost {
  id: string; // "<handle>/<messageId>"
  text: string;
  publishedAt: Date;
}

// Postgres text columns reject a handful of things browsers tolerate fine:
// a literal NUL byte, other C0 control characters, and lone (unpaired)
// UTF-16 surrogates — any of which fails the *whole* batch insert in
// ingest.ts (rows are inserted together in one statement), not just this
// one row. A live run hit exactly this. Numeric HTML entities can decode
// to codepoints that produce an unpaired surrogate if malformed, so this
// runs after entity decoding, not before. Iterating by code point (rather
// than a regex character class) sidesteps having to embed literal control
// characters in source at all.
function sanitizeForStorage(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isTabOrNewline = code === 9 || code === 10 || code === 13;
    const isControlChar = code < 32 || code === 127;
    if (isControlChar && !isTabOrNewline) continue;
    out += ch;
  }
  return out.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

function decodeEntities(html: string): string {
  const decoded = html
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
  return sanitizeForStorage(decoded);
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

// A live run found `sanitizeForStorage`'s unpaired-surrogate stripping
// getting undone right afterward: plain `.slice()` counts UTF-16 code
// units, so cutting at exactly N chars can land inside a surrogate pair
// (most emoji) and leave a dangling half behind — reintroducing the exact
// problem sanitizeForStorage exists to prevent. Array.from splits a string
// into whole code points, so slicing the array can't split a pair.
function truncateSafely(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length > maxChars ? chars.slice(0, maxChars).join("") : text;
}

const LANGUAGE_NAMES: Record<string, string> = {
  uk: "Ukrainian",
  ru: "Russian",
  fa: "Farsi",
};

function excerptOf(text: string): string {
  return text.length > EXCERPT_MAX_CHARS
    ? `${truncateSafely(text, EXCERPT_MAX_CHARS)}…`
    : text;
}

function toDirectItem(
  post: TelegramPost,
  excerpt: string,
  translated: boolean,
  config: TelegramChannelConfig,
): DirectItem | null {
  const centroid = COUNTRY_CENTROIDS[config.country];
  if (!centroid) return null;

  // See docs/TELEGRAM_SOURCES.md "Framing discipline" — always named,
  // never presented as a neutral wire report. Machine-translated text is
  // marked as such rather than presented as if it were the channel's own
  // English phrasing — see docs/OSINT_SOURCES.md's Telegram section for
  // why (GOOGLE_TRANSLATE_API_KEY gates this; text stays in its original
  // language, untranslated, if the key isn't set).
  const translationNote = translated ? ` [translated from ${LANGUAGE_NAMES[config.language] ?? config.language}]` : "";
  const summary = `${config.label}${translationNote}: ${excerpt}`;

  return {
    source: `telegram:${config.handle}`,
    url: `https://t.me/${post.id}`,
    title: summary.length > 120 ? `${truncateSafely(summary, 117)}...` : summary,
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
  if (posts.length === 0) return [];

  const excerpts = posts.map((p) => excerptOf(p.text));

  // Batch-translate the whole channel's excerpts in one request rather
  // than per-post — see src/lib/translate.ts. Soft-degrades to the
  // original-language excerpts (translated: false) if no key is
  // configured, the API call fails, or the channel is already English
  // (presstv) — never blocks ingest on translation being available.
  let finalExcerpts = excerpts;
  let translated = false;
  if (config.language !== "en") {
    const result = await translateBatch(excerpts, config.language).catch(() => null);
    if (result) {
      finalExcerpts = result.map((t, i) =>
        // Translation runs on the already-sanitized excerpt, but the API
        // response itself needs the same control-char/surrogate cleanup
        // applied before it can safely reach Postgres.
        sanitizeForStorage(t) || excerpts[i],
      );
      translated = true;
    }
  }

  return posts
    .map((p, i) => toDirectItem(p, finalExcerpts[i], translated, config))
    .filter((item): item is DirectItem => item !== null);
}
