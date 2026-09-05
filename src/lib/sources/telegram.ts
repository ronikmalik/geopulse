import type { Category } from "../categories";
import type { DirectItem } from "./direct";
import { COUNTRY_CENTROIDS } from "../countryCentroids";
import { translateBatch } from "../translate";
import { assessIncidentSeverity, MIN_SEVERITY_TO_INCLUDE } from "../classify";
import { archiveClassifications, type ClassificationOutcome } from "../classificationArchive";

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
// was deliberately left out. The 2026-09-04 v2 pass (multi-report,
// multi-theater audit, not just one day) added the block below the divider
// comment — same bar as v1: unambiguous institutional identity, cited
// repeatedly by ISW/CTP, not a personal/analyst/milblogger account (those
// stay in TELEGRAM_SOURCES.md's "Tier 2 candidates" pending individual
// credibility reads, per the discipline already established for v1).
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
  // --- v2 additions (2026-09-04), see docs/TELEGRAM_SOURCES.md "v2" section ---
  { handle: "DIUkraine", label: "Ukrainian Defense Intelligence (official)", country: "UA", category: "russia-ukraine", language: "uk" },
  { handle: "Joint_Forces_Task_Force", label: "Ukrainian Joint Forces (official military)", country: "UA", category: "russia-ukraine", language: "uk" },
  { handle: "V_Zelenskiy_official", label: "Volodymyr Zelensky (official)", country: "UA", category: "russia-ukraine", language: "uk" },
  { handle: "medvedev_telegram", label: "Dmitry Medvedev — Deputy Chair, Russian Security Council (official)", country: "RU", category: "russia-ukraine", language: "ru" },
  { handle: "defapress_ir", label: "Defa Press — Iranian Defense Ministry press organ (official)", country: "IR", category: "us-iran", language: "fa" },
  { handle: "sepah_pasdaran", label: "IRGC (official)", country: "IR", category: "us-iran", language: "fa" },
  { handle: "TasnimNewsAgency", label: "Tasnim News (IRGC-affiliated wire)", country: "IR", category: "us-iran", language: "fa" },
  { handle: "mehrnews", label: "Mehr News Agency (Iran semi-official state media)", country: "IR", category: "us-iran", language: "fa" },
  { handle: "Nournews_ir", label: "Nour News (Iran Supreme National Security Council-linked)", country: "IR", category: "us-iran", language: "fa" },
  { handle: "army21ye", label: "Houthi Armed Forces spokesperson (official, unverified claims)", country: "YE", category: "us-iran", language: "ar" },
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
  ar: "Arabic",
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
  severity: number,
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
    severity,
    publishedAt: post.publishedAt,
  };
}

// The bar for what actually gets stored: a channel like Rybar or the
// Ukraine General Staff posts constantly — casualty tallies, procurement
// news, morale pieces, generic statements — and treating every post as a
// map-worthy "event" turned this into a raw channel mirror instead of a
// breaking-news layer (this is what the user flagged: "we are using all of
// the telegram stuff"). This reuses classify.ts's own incident-severity
// judgment (BENIGN/ONGOING suppression + escalation-verb scoring).
// mild-only language (warnings, sanctions, "tension," protests) is exactly
// the kind of routine channel chatter this is meant to filter out, so
// Telegram requires actual incident-level wording — a strike, a capture, a
// territory reclaimed, a drone shot down — not just topic proximity. This
// used to be a stricter floor than the general RSS/GDELT feed
// (MIN_SEVERITY_TO_INCLUDE was 2 there); as of 2026-09-04 that floor was
// raised to match this one exactly, so this reuses the same constant
// rather than keeping a second number that could silently drift out of
// sync with it — one consistent "truly breaking" bar across every source.
const TELEGRAM_MIN_SEVERITY = MIN_SEVERITY_TO_INCLUDE;

// User's explicit request (2026-09-05): "i dont like that slop is still
// flowing through iranian state presstv... make sure only live breaking
// news conflict events go through." classify.ts's shared MODERATE_SEVERITY
// (used by severity scoring above) deliberately accepts bare "sanctions"
// and other administrative/policy language unconditionally — a real,
// separately-confirmed decision for RSS/GDELT ("i like the sanctions
// article" for a substantive US-sanctions-a-bank story earlier this
// session). The problem is Telegram-specific: raw channel posts routinely
// bundle a throwaway policy mention into an otherwise rhetorical/editorial
// post ("Trump lifts sanctions on notorious Al Qaeda figures as America
// prepares for 25th [9/11 anniversary]...") which scored severity 3 purely
// from "sanctions," with zero actual conflict action in the post. Scoped
// to Telegram only — not a change to classify.ts's shared patterns, which
// would regress that RSS/GDELT feedback.
//
// Requires genuine kinetic/conflict-action language on top of the existing
// severity floor, rather than replacing it — every real example checked
// (drone strikes, airstrikes, deadly wedding strike, fierce fighting in
// Yemen, a Russian drone hitting Ukraine's SBU) already uses this exact
// vocabulary, so this doesn't narrow real coverage. The "threatens/vows to"
// lookbehind exists because "Trump once again threatens to attack Iran's
// Pickaxe Mountain" contains the word "attack" but describes a possible
// future action, not one that happened — same distinction classify.ts
// already draws elsewhere for "stop/end/halt the fighting" style rhetoric.
const CONFLICT_ACTION_PATTERN =
  /\bstrikes?\b|missile (launch|fired|strike)|airstrike|(?<!threatens? to )(?<!vows? to )\battack(ed|ing|s)?\b|\bkilled\b|\bdead\b|casualties|wounded|injured|explosion|bombing|clashes?|shot down|downed (a |an )?(drone|aircraft|jet|missile)|intercepted|cleared (tunnels|the area)|(?<!threatens? to )\bstruck\b|hit by|\bfighting\b|recaptur(ed|es|ing)|\bretook\b|\bretake\b|reclaim(ed|s|ing)|liberat(ed|es|ing)|repel(led|s)?|thwart(ed|s)?|destroy(ed|s)?|neutrali[sz]ed|eliminat(ed|es)|liquidat(ed|es)|raid(ed|s)?|storm(ed|s)?|mobiliz|border incident/i;

// Only English or successfully-translated text can be scored against the
// (English-language) incident keywords at all. Rather than guess at
// untranslated foreign-language text's severity (or worse, store it
// unfiltered), posts are dropped outright when no reliable read is
// possible — consistent with this file's general precision-over-recall
// stance elsewhere (see docs/TELEGRAM_SOURCES.md).
function canAssess(config: TelegramChannelConfig, translated: boolean): boolean {
  return config.language === "en" || translated;
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

  if (!canAssess(config, translated)) return [];

  // Every scoreable post — kept AND dropped — is archived to
  // classification_archive (see src/lib/classificationArchive.ts), same
  // as GDELT/RSS in src/lib/ingest.ts. `severity === null` (BENIGN/
  // ONGOING-suppressed entirely, not just below the bar) is logged as 1
  // for archival purposes — there's no meaningful difference for
  // vocabulary-discovery purposes between "scored 1" and "suppressed
  // outright", both mean "nothing here looks like an incident."
  const archiveOutcomes: ClassificationOutcome[] = [];

  const items = posts
    .map((p, i) => {
      const severity = assessIncidentSeverity(finalExcerpts[i]);
      const kept =
        severity !== null &&
        severity >= TELEGRAM_MIN_SEVERITY &&
        CONFLICT_ACTION_PATTERN.test(finalExcerpts[i]);
      archiveOutcomes.push({
        source: `telegram:${config.handle}`,
        url: `https://t.me/${p.id}`,
        title: finalExcerpts[i].slice(0, 200),
        snippet: finalExcerpts[i],
        kept,
        severity: severity ?? 1,
        category: kept ? config.category : null,
        publishedAt: p.publishedAt,
      });
      if (!kept) return null;
      return toDirectItem(p, finalExcerpts[i], translated, config, severity as number);
    })
    .filter((item): item is DirectItem => item !== null);

  await archiveClassifications(archiveOutcomes);

  return items;
}
