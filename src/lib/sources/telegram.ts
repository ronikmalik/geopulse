import type { Category } from "../categories";
import { stripEmoji } from "../textSanitize";
import type { DirectItem } from "./direct";
import { COUNTRY_CENTROIDS } from "../countryCentroids";
import { translateBatch } from "../translate";
import { assessIncidentSeverity, MIN_SEVERITY_TO_INCLUDE } from "../classify";
import {
  archiveClassifications,
  getArchivedUrls,
  type ClassificationOutcome,
} from "../classificationArchive";
import { enqueuePendingTranslations } from "../pendingTranslation";
import { hasLikelyForeignIncidentLanguage } from "../foreignIncidentKeywords";
import { byteLength } from "../translate";

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
  // category corrected 2026-09-11 (user report) from "natural-disaster" to
  // "russia-ukraine" — DSNS's real posting content is overwhelmingly
  // Russian-strike/shelling-caused fires and casualties ("Russian drone
  // strike on an ambulance," "enemy UAV hitting a five-story administrative
  // building"), not natural-cause incidents (earthquake, wildfire, flood —
  // the direct/structural sources FIRMS/EONET/GDACS already cover those).
  // Every channel here gets a single fixed category (see the DirectItem
  // builder below — no per-post keyword classification), so a wrong pick
  // here mislabels 100% of the channel's output, not just edge cases.
  { handle: "dsns_telegram", label: "Ukraine State Emergency Service (official)", country: "UA", category: "russia-ukraine", language: "uk" },
  { handle: "rybar", label: "Rybar (pro-Russian military channel, unverified)", country: "RU", category: "russia-ukraine", language: "ru" },
  { handle: "wargonzo", label: "WarGonzo (pro-Russian military channel, unverified)", country: "RU", category: "russia-ukraine", language: "ru" },
  { handle: "presstv", label: "Press TV (Iran state media)", country: "IR", category: "us-iran", language: "en" },
  // --- v2 additions (2026-09-04), see docs/TELEGRAM_SOURCES.md "v2" section ---
  { handle: "DIUkraine", label: "Ukrainian Defense Intelligence (official)", country: "UA", category: "russia-ukraine", language: "uk" },
  { handle: "Joint_Forces_Task_Force", label: "Ukrainian Joint Forces (official military)", country: "UA", category: "russia-ukraine", language: "uk" },
  { handle: "V_Zelenskiy_official", label: "Volodymyr Zelensky (official)", country: "UA", category: "russia-ukraine", language: "uk" },
  { handle: "medvedev_telegram", label: "Dmitry Medvedev — Deputy Chair, Russian Security Council (official)", country: "RU", category: "russia-ukraine", language: "ru" },
  // defapress_ir, sepah_pasdaran, TasnimNewsAgency, mehrnews, Nournews_ir
  // removed (2026-09-10, user request) — the five worst-yielding Farsi
  // channels by real all-time data: TasnimNewsAgency 0/20 kept (0%, ever),
  // sepah_pasdaran 5/155 (3.2%), mehrnews 7/307 (2.3%), Nournews_ir 8/392
  // (2.1%), defapress_ir 4/100 (4%) — together 44% of the current
  // translation-pending backlog (180/409) and ~42% of all-time translated-
  // candidate volume, for a combined ~2.7% keep rate.
  //
  // iribnews and farsna removed in a follow-up pass, same day — real
  // content comparison against presstv found direct duplication, not just
  // topical overlap: iribnews and farsna repeated each other's wire text
  // near-verbatim in multiple cases (both mirror Al-Mayadeen — Arabic-
  // language, not English, so this wasn't presstv's own content leaking
  // in), and presstv (English, zero translation cost) independently
  // covered several of the same real events (the Sirik/Kuhestak wedding
  // strike, Gaza/Lebanon strikes) that iribnews/farsna spent real
  // translation budget to also surface.
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
  out = out.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  return stripEmoji(out);
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
// 280 -> 200 chars (2026-09-10, translation-budget optimization): kept posts
// averaged 230 chars, dropped posts averaged 158 — most real incident
// reports fit comfortably under 200, this just trims the tail on the
// (usually-dropped) longer end rather than losing real signal.
//
// Chars -> BYTES (2026-09-10, same day, follow-up): a character cap doesn't
// actually cap what gets billed — Ukrainian/Russian/Farsi/Arabic (every
// language this excerpt gets translated FROM) run ~2 bytes/char in UTF-8,
// so the "200-char" cap above was really an unbounded-ish ~350-400 BYTE
// cap depending on the exact text. 400 is chosen to match that real
// existing cost for a typical 200-char non-Latin excerpt almost exactly —
// this isn't a new content cut on top of the one above, it's making the
// existing cap actually mean what it was already supposed to cost, and it
// catches the outlier posts (denser multi-byte characters, combining
// diacritics) that a char-only cap let slip past 400+ bytes uncapped.
const EXCERPT_MAX_BYTES = 400;

// Telegram posts routinely carry boilerplate that costs real translation
// bytes but carries zero incident signal: a bare source URL, a hashtag
// block, a channel self-mention (@handle). None of this is needed for
// classification (the real source link lives in DirectItem.url, built
// from the post's own t.me id, not from anything inside the text) or for
// display (this excerpt is already framed with the channel's own label —
// see toDirectItem below), so stripping it before translating spends the
// byte budget on actual prose instead. Runs before truncation so a post
// that opens with a hashtag block doesn't lose real trailing content to
// it.
const URL_PATTERN = /https?:\/\/\S+/g;
const HASHTAG_PATTERN = /#\S+/g;
const MENTION_PATTERN = /@\S+/g;

function stripBoilerplate(text: string): string {
  return text
    .replace(URL_PATTERN, "")
    .replace(HASHTAG_PATTERN, "")
    .replace(MENTION_PATTERN, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

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

// Same whole-codepoint safety as truncateSafely above, but bounded by
// actual UTF-8 byte length rather than character count — see
// EXCERPT_MAX_BYTES's own comment for why bytes are what actually matter
// here. Walks codepoints (not UTF-16 code units) so a cut can't land
// inside a multi-byte character or a surrogate pair.
function truncateSafelyBytes(text: string, maxBytes: number): string {
  const chars = Array.from(text);
  let usedBytes = 0;
  let cutIndex = chars.length;
  for (let i = 0; i < chars.length; i++) {
    usedBytes += byteLength(chars[i]);
    if (usedBytes > maxBytes) {
      cutIndex = i;
      break;
    }
  }
  return cutIndex < chars.length ? chars.slice(0, cutIndex).join("") : text;
}

const LANGUAGE_NAMES: Record<string, string> = {
  uk: "Ukrainian",
  ru: "Russian",
  fa: "Farsi",
  ar: "Arabic",
};

function excerptOf(text: string): string {
  const cleaned = stripBoilerplate(text);
  return byteLength(cleaned) > EXCERPT_MAX_BYTES
    ? `${truncateSafelyBytes(cleaned, EXCERPT_MAX_BYTES)}…`
    : cleaned;
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

// User follow-up correction, same conversation (2026-09-05): "iran's
// direct threats for conflict should be kept" — CONFLICT_ACTION_PATTERN's
// "threatens/vows to" exclusion was too broad. A state or military actor
// directly threatening imminent conflict ("Iranian Army advises US to pay
// price of aggression, leave region") IS itself real geopolitical signal,
// distinct from the vague diplomatic sparring this filter exists to catch
// ("Israel threatens economic, political response to London" — a policy
// dispute, not a conflict threat). This pattern is deliberately narrower
// than CONFLICT_ACTION_PATTERN's exclusion would suggest: it requires the
// threatened action itself be military/violent (attack, strike, retaliate,
// consequences/reprisal), not just the presence of the word "threatens."
const DIRECT_THREAT_PATTERN =
  /\bpay(s)? (the )?price\b|\bvows? to (attack|strike|retaliate)\b|\bthreatens? to (attack|strike|retaliate)\b|\bwarns? of (retaliation|reprisal|consequences)\b|\bwill retaliate\b/i;

// Only English or successfully-translated text can be scored against the
// (English-language) incident keywords at all. Rather than guess at
// untranslated foreign-language text's severity (or worse, store it
// unfiltered), posts are dropped outright when no reliable read is
// possible — consistent with this file's general precision-over-recall
// stance elsewhere (see docs/TELEGRAM_SOURCES.md).
function canAssess(config: TelegramChannelConfig, translated: boolean): boolean {
  return config.language === "en" || translated;
}

// User request (2026-09-06): "presstv is giving actual filth still...
// make it so that channel exclusively about iran getting attacked or
// iran threatening to attack others. i want nothing about israel
// palestine especially." Scoped to presstv alone — Iran's own state
// broadcaster — not the general Telegram bar every other channel still
// uses, and not a change to classify.ts's israel-palestine category
// itself (RSS/GDELT coverage of that conflict is untouched; this is
// specifically about what Iran's state media is allowed to surface here).
//
// Hard veto first: any Gaza/Palestine/West Bank/Hamas mention drops the
// post outright, even if it also uses kinetic-action language or names
// Iran in passing ("Iran's FM comments on Gaza ceasefire") — that's
// exactly the "filth" being described, Press TV using Israel-Palestine
// commentary as content rather than reporting real Iran-conflict news.
// Only past that gate does the normal conflict-action/direct-threat check
// apply, with the added requirement that a real axis-of-resistance actor
// actually be named — one of them has to be attacked or the one
// threatening, not merely present in an unrelated regional story.
const PRESSTV_EXCLUDE_PATTERN =
  /\bgaza\b|\bpalestin(e|ian)s?\b|west bank|\bhamas\b/i;

// Widened 2026-09-10 (user request) from a bare Iran-mention requirement:
// "if we let presstv cover axis of resistance theater content" — Iran's
// own state media naturally covers the whole aligned network (Yemen/
// Houthi, Lebanon/Hezbollah, Iraq/PMF and Iran-proxy militias), not just
// direct Iran incidents, and that's real, distinct coverage this app was
// missing entirely (see the iribnews/farsna investigation this same
// session — presstv structurally couldn't surface a Kirkuk PMF-vs-ISIS
// clash or Yemeni forces retaking a coastal city, since neither names
// Iran). The Gaza/Palestine veto above is untouched — that was a
// separate, deliberate exclusion, not part of this widening.
const PRESSTV_AXIS_OF_RESISTANCE_PATTERN =
  /\biran(ian)?\b|\bhouthis?\b|ansar allah|\bhezbollah\b|\birgc\b|quds force|revolutionary guard|kata'?ib hezbollah|asa'?ib ahl al-haq|al-nujaba|islamic resistance in iraq|popular mobilization|\bpmf\b|\byemen(i)?\b|\biraq(i)?\b|\blebanon(ese)?\b/i;

// Same request, second half: "i dont want propaganda, just real events."
// Iranian state media routinely labels analyst/commentary segments
// explicitly rather than blending them into straight reporting — "Feature
// - Qassem-e-Basir and economics of attrition...", "🎤 Conversation - US
// bombing of a wedding...", "Analyst: Failed cycle of US Iran policy...".
// These aren't a report that something new happened, they're an
// interpretation of something already reported — the same "reflection,
// not a fresh development" distinction classify.ts's own
// NON_EVENT_TITLE_PATTERNS draws for RSS headlines, but Telegram posts use
// different framing markers (emoji-prefixed segment labels, not headline
// conventions) that pattern doesn't cover, so this is its own check
// rather than a forced reuse. Honesty check on this pattern's own limits:
// it only catches EXPLICITLY labeled segments, not every possible form of
// commentary (an unlabeled quote from a named pundit reacting to a real
// strike can still get through) — a real but partial mitigation, not a
// complete propaganda filter.
const PRESSTV_ANALYSIS_PATTERN =
  /^.{0,10}\b(feature|conversation|analyst|analysis|commentary|opinion|op-ed|explainer|interview)\b\s*[-:]/i;

// User follow-up, same request: catches a named subject quoted making a
// claim or interpretation, rather than a state/military actor's own
// action being reported. Real example that motivated this: '"US attacks
// against Iranian oil vessels are an act of desperation": Nick Mottern
// says Trump's attacks... are an act of desperation amid US weapons
// shortages...' — full of real conflict vocabulary, but the actual
// subject is a commentator's opinion about an already-known event, not a
// fresh development.
//
// WIDENED 2026-09-11 (explicit user instruction: "remove any (name) says
// or (name name) says. doesnt matter who it is, just remove the things
// where someone is saying something" — garbage was still getting
// through). This used to only fire when NO official title appeared
// anywhere in the excerpt, exempting quotes from spokesmen, ministers,
// IRGC officials, etc. That exemption is gone: a statement/claim is out
// of scope for presstv regardless of who's making it, official or not —
// "IRGC spokesman warns..." is now excluded exactly like "Nick Mottern
// says...". This is a deliberate policy shift, not a bug: presstv should
// carry real events (a strike happened, forces clashed), not anyone's
// reported statement ABOUT events, however authoritative the speaker.
// Also widened from two-word full names to one-or-two capitalized words
// ("Trump says" now matches, not just "Donald Trump says"), and the verb
// list grew to cover more reporting-speech phrasing. See
// classifierAudit.ts's DELIBERATE_EXCLUSIONS for the same rule restated
// for Gemini's own judgment — that text must stay in sync with this one,
// same lesson as the 2026-09-10 auto-apply bug this file's own history
// already documents below.
//
// Live-tested against a mix of real attribution and real event headlines
// before shipping (2026-09-11) — caught two real gaps the first pass of
// this widening missed: an ALL-CAPS acronym subject ("IRGC spokesman
// warns...") and a missing verb ("Foreign Ministry condemned..."). Fixed
// by relaxing the subject match to any word starting with a capital
// (covers acronyms like IRGC/PMF, not just Title Case names) followed by
// up to two more words of EITHER case (covers a role noun like
// "spokesman" that isn't itself capitalized), and adding "condemns/
// condemned" to the verb list.
const PRESSTV_NAMED_INDIVIDUAL_CLAIM_PATTERN =
  /\b[A-Z][\w']*(?:\s+[A-Za-z][\w']*){0,2}\s+(says|said|tells|told|argues|contends|believes|claims|claimed|warns|warned|insists|insisted|stated|asserts|asserted|condemns|condemned)\b/;

function isPresstvIndividualAttribution(excerpt: string): boolean {
  return PRESSTV_NAMED_INDIVIDUAL_CLAIM_PATTERN.test(excerpt);
}

// Exported so classifierAudit.ts's false_negative auto-apply path can
// check it too (2026-09-10, real bug found live): Gemini's audit has no
// concept of a source-specific scope restriction, and auto-applied a
// "false negative" recovery for a presstv post that was correctly dropped
// by this exact rule ("Israeli military launched a fresh wave of attacks
// on southern Lebanon..." — no Iran mention at all), reasoning it was
// "over-application of the exclusion rule." It wasn't a classifier
// mistake, it was the deliberate policy this function exists to enforce —
// see this function's own history above.
export function isPressTvInScope(excerpt: string): boolean {
  return (
    !PRESSTV_EXCLUDE_PATTERN.test(excerpt) &&
    !PRESSTV_ANALYSIS_PATTERN.test(excerpt) &&
    !isPresstvIndividualAttribution(excerpt) &&
    PRESSTV_AXIS_OF_RESISTANCE_PATTERN.test(excerpt)
  );
}

// A Ukrainian Air Force-style alert naming a SPECIFIC city as currently
// under a tracked aerial threat ("over the city! stay in shelter") —
// user request (2026-09-10), real evidence from kpszsu (24 all-time
// occurrences sampled, e.g. "Kyiv / Jet UAV over the city! Stay in
// cover!"). Distinct from both existing patterns: not a confirmed strike
// (CONFLICT_ACTION_PATTERN), not a state actor vowing future action
// (DIRECT_THREAT_PATTERN) — the object is directly over a named,
// populated location right now, meaningfully more acute than ordinary
// "heading toward X" in-transit tracking, which stays excluded. See
// foreignIncidentKeywords.ts's "над містом" addition for the matching
// pre-translation side of this.
const IMMEDIATE_CITY_THREAT_PATTERN = /over the city|stay in (cover|shelter)/i;

// Used by the live fetch path below — the sole source of kept/dropped
// decisions now that nothing drains pending_translation anymore. Returns
// the severity to actually store/display, not just a bare boolean.
// Immediate-city-threat posts are a deliberate exception (user, 2026-09-10:
// "ok to keep uav over city as a threat level 1") — kept even though
// classify.ts's shared severity scorer (tuned for confirmed strikes/
// casualties, not live tracking alerts) sees no signal and scores it 1;
// that low severity is left as-is rather than inflated, since it's an
// honest reflection of "a tracked threat, not a confirmed strike."
function evaluateConflictPost(
  excerpt: string,
  computedSeverity: number | null,
  handle: string,
): { kept: boolean; severity: number } {
  const immediateCityThreat = IMMEDIATE_CITY_THREAT_PATTERN.test(excerpt);
  const meetsActionOrThreatBar =
    computedSeverity !== null &&
    computedSeverity >= TELEGRAM_MIN_SEVERITY &&
    (CONFLICT_ACTION_PATTERN.test(excerpt) || DIRECT_THREAT_PATTERN.test(excerpt));

  if (!immediateCityThreat && !meetsActionOrThreatBar) {
    return { kept: false, severity: computedSeverity ?? 1 };
  }
  if (handle === "presstv" && !isPressTvInScope(excerpt)) {
    return { kept: false, severity: computedSeverity ?? 1 };
  }
  return { kept: true, severity: computedSeverity ?? 1 };
}

export async function fetchTelegramChannel(
  config: TelegramChannelConfig,
): Promise<DirectItem[]> {
  const html = await fetchChannelHtml(config.handle);
  const allPosts = parseChannelHtml(html);
  if (allPosts.length === 0) return [];

  // Telegram's web preview always returns the channel's ~20 most recent
  // posts, not "what's new since the last fetch" — with two independent
  // schedulers now hitting /api/ingest (cron-job.org's own schedule plus
  // the GitHub Actions backup, which sat silently dead from 2026-08-27
  // until it was fixed on 2026-09-04 — see ingest.yml and
  // docs/ARCHITECTURE.md), the exact same posts routinely get fetched
  // twice within the same 15-minute rotation bucket. Anything already in
  // classification_archive was already fully scored (kept or dropped) in
  // a prior cycle, so it's filtered out before translation is even
  // attempted, not just before insertion — this is what actually stopped
  // the character budget from being burned twice over on identical text
  // (see the 2026-09-05 "why did translation usage spike" investigation).
  const archivedUrls = await getArchivedUrls(
    allPosts.map((p) => `https://t.me/${p.id}`),
  ).catch(() => new Set<string>());
  const posts = allPosts.filter((p) => !archivedUrls.has(`https://t.me/${p.id}`));
  if (posts.length === 0) return [];

  const excerpts = posts.map((p) => excerptOf(p.text));

  const archiveOutcomes: ClassificationOutcome[] = [];

  // Pre-translation triage (2026-09-10, translation-budget optimization —
  // see foreignIncidentKeywords.ts's own doc comment for the full
  // reasoning and real numbers). English channels skip this — there's
  // nothing to save by pre-filtering text that was never going to be
  // translated anyway. Posts that don't even look like they contain
  // incident/threat language in their OWN language are archived as
  // dropped immediately, at zero translation cost, instead of being
  // translated first just to find out.
  const toTranslateIdx: number[] = [];
  if (config.language !== "en") {
    posts.forEach((p, i) => {
      if (hasLikelyForeignIncidentLanguage(excerpts[i], config.language)) {
        toTranslateIdx.push(i);
      } else {
        archiveOutcomes.push({
          source: `telegram:${config.handle}`,
          url: `https://t.me/${p.id}`,
          title: excerpts[i].slice(0, 200),
          snippet: excerpts[i],
          kept: false,
          severity: 1,
          category: null,
          publishedAt: p.publishedAt,
        });
      }
    });
  } else {
    posts.forEach((_, i) => toTranslateIdx.push(i));
  }

  if (toTranslateIdx.length === 0) {
    await archiveClassifications(archiveOutcomes);
    return [];
  }

  const candidatePosts = toTranslateIdx.map((i) => posts[i]);
  const candidateExcerpts = toTranslateIdx.map((i) => excerpts[i]);

  // Batch-translate the whole channel's excerpts in one request rather
  // than per-post — see src/lib/translate.ts. Soft-degrades to the
  // original-language excerpts (translated: false) if no key is
  // configured or the channel is already English (presstv) — never
  // blocks ingest on translation being available.
  let finalExcerpts = candidateExcerpts;
  let translated = false;
  if (config.language !== "en") {
    const result = await translateBatch(candidateExcerpts, config.language).catch(() => null);
    if (result) {
      finalExcerpts = result.map((t, i) =>
        // Translation runs on the already-sanitized excerpt, but the API
        // response itself needs the same control-char/surrogate cleanup
        // applied before it can safely reach Postgres.
        sanitizeForStorage(t) || candidateExcerpts[i],
      );
      translated = true;
    } else {
      // Couldn't translate this cycle — today's byte budget is already
      // spent, or the Translate API call itself failed. Rather than drop
      // live content just because quota happens to be tight right now
      // (user, 2026-09-05: "dont remove stuff just because we run out of
      // translation tokens"), park these brand-new posts — not for a later
      // retry (2026-09-10: nothing drains this anymore), just preserved
      // until removeAlreadyResolvedPending notices it resolved some other
      // way or a future decision is made. Only the pre-filtered candidates
      // get queued — the pre-filtered-out posts above are already
      // archived, not lost, just never queued in the first place.
      await enqueuePendingTranslations(
        candidatePosts.map((p, i) => ({
          url: `https://t.me/${p.id}`,
          handle: config.handle,
          excerpt: candidateExcerpts[i],
          publishedAt: p.publishedAt,
        })),
      ).catch((err) => console.error(`enqueuePendingTranslations failed: ${err}`));
      await archiveClassifications(archiveOutcomes);
      return [];
    }
  }

  if (!canAssess(config, translated)) {
    await archiveClassifications(archiveOutcomes);
    return [];
  }

  // Every scoreable post — kept AND dropped — is archived to
  // classification_archive (see src/lib/classificationArchive.ts), same
  // as GDELT/RSS in src/lib/ingest.ts. `severity === null` (BENIGN/
  // ONGOING-suppressed entirely, not just below the bar) is logged as 1
  // for archival purposes — there's no meaningful difference for
  // vocabulary-discovery purposes between "scored 1" and "suppressed
  // outright", both mean "nothing here looks like an incident."
  const items = candidatePosts
    .map((p, i) => {
      const computedSeverity = assessIncidentSeverity(finalExcerpts[i]);
      const { kept, severity } = evaluateConflictPost(finalExcerpts[i], computedSeverity, config.handle);
      archiveOutcomes.push({
        source: `telegram:${config.handle}`,
        url: `https://t.me/${p.id}`,
        title: finalExcerpts[i].slice(0, 200),
        snippet: finalExcerpts[i],
        kept,
        severity,
        category: kept ? config.category : null,
        publishedAt: p.publishedAt,
      });
      if (!kept) return null;
      return toDirectItem(p, finalExcerpts[i], translated, config, severity);
    })
    .filter((item): item is DirectItem => item !== null);

  await archiveClassifications(archiveOutcomes);

  return items;
}

// Nothing drains pending_translation for translation purposes anymore
// (2026-09-10, user request — see enqueuePendingTranslations's own doc
// comment in pendingTranslation.ts). It's a pure holding pen now: a post
// either gets translated the cycle it's discovered, using that cycle's
// live budget, or it sits here untouched until removeAlreadyResolvedPending
// notices it resolved some other way, or until a future decision is made
// about what to do with it.
