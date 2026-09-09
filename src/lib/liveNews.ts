// Live televised news coverage — a curated set of 24/7 international
// broadcast channels, embedded via YouTube's channel-live endpoint
// (resolves to whatever that broadcaster currently has on air, no
// video-ID juggling required). This is deliberately NOT tied to any single
// flashpoint: picking a broadcaster is about which live feed is most
// likely to be covering a given region right now, not which of the five
// default categories a country belongs to.
//
// Every channel ID below was verified two ways before shipping: (1) the ID
// resolves to that broadcaster's real YouTube channel (checked against
// each channel's own about page), and (2) it actually embeds — checked
// live in this app's real production iframe, not a synthetic test page
// (a standalone multi-iframe test harness gave false negatives even for
// channels confirmed working in the real app). "Embeds" isn't guaranteed
// by a correct channel ID: YouTube's live_stream?channel= embed silently
// renders "This video is unavailable" with no error/console signal for
// any broadcaster that has embedding disabled for their live stream,
// regardless of whether the channel itself is real and currently live.
//
// Full result of the 2026-09-09 sweep (22 broadcasters tested this way):
// WORKING — Al Jazeera English, France 24 English, DW News,
// NHK World-Japan, Africanews, NBC News, ABC News, CBS News,
// Bloomberg Television, TRT World, Rappler.
// BROKEN (real channel, embedding just doesn't work) — Sky News (the
// previous default — this is what originally motivated this sweep), CNA,
// WION, euronews, Reuters, AP, ArirangTV, i24NEWS English, ABS-CBN News,
// Times Now, NDTV.
export interface LiveChannel {
  id: string; // YouTube channel ID (UC...)
  name: string;
  region: string;
}

export const LIVE_CHANNELS: Record<string, LiveChannel> = {
  aljazeera: {
    id: "UCNye-wNBqNL5ZzHSJj3l8Bg",
    name: "Al Jazeera English",
    region: "Middle East / South Asia / Global South",
  },
  france24: {
    id: "UCQfwfsi5VrQ8yKZ-UWmAEFg",
    name: "France 24 English",
    region: "Europe / Africa / Francophone world",
  },
  dwnews: {
    id: "UCknLrEdhRCp1aegoMqRaCZg",
    name: "DW News",
    region: "Germany",
  },
  nbcnews: {
    id: "UCeY0bbntWzzVIaj2z3QigXg",
    name: "NBC News",
    region: "Americas / Anglophone West",
  },
  rappler: {
    id: "UCdnZdQxYXnbN4uWJg96oGxw",
    name: "Rappler",
    region: "Southeast Asia",
  },
  nhkworld: {
    id: "UCSPEjw8F2nQDtmUKPFNF7_A",
    name: "NHK World-Japan",
    region: "East Asia / Japan",
  },
  africanews: {
    id: "UC1_E8NeF5QHY2dtdLRBCCLA",
    name: "Africanews",
    region: "Africa",
  },
  // Additional working options, not auto-suggested for any region (always
  // manually selectable) — redundancy plus an editorial-perspective/lens
  // choice on top of the auto-picked default.
  abcnews: { id: "UCBi2mrWuNuyYy4gbM6fU18Q", name: "ABC News", region: "US" },
  cbsnews: { id: "UC8p1vwvWtl6T73JiExfWs1g", name: "CBS News", region: "US" },
  bloomberg: {
    id: "UCIALMKvObZNtJ6AmdCLP7Lg",
    name: "Bloomberg TV",
    region: "Global markets",
  },
  // Turkish state-funded broadcaster — YouTube discloses this directly on
  // the embed itself (the "TRT is a Turkish..." funding-transparency
  // label), same treatment this app gives Press TV/CGTN-style sources
  // elsewhere: included for its distinct vantage point, not presented as
  // neutral wire coverage.
  trtworld: { id: "UC7fWeaHhqgM4Ry-RMpM2YYw", name: "TRT World", region: "Global (Turkish state media)" },
};

export type LiveChannelId = keyof typeof LIVE_CHANNELS;

// Al Jazeera — always-live, globally comprehensive, confirmed working
// throughout the 2026-09-09 verification sweep. Replaces the old default
// (Sky News), which is what triggered this whole re-evaluation: it simply
// doesn't embed, and had been silently broken with no error surfaced
// anywhere in the app.
export const DEFAULT_LIVE_CHANNEL: LiveChannelId = "aljazeera";

// Country (ISO alpha-2) -> broadcaster whose live feed is most likely to
// actually be covering that country right now. Deliberately broad regional
// buckets, not a country-by-country lookup for all ~195 countries — the
// goal is "reasonable default, always overridable," not exhaustive.
const REGION_MAP: Record<LiveChannelId, string[]> = {
  aljazeera: [
    "IL", "PS", "IR", "IQ", "SY", "LB", "JO", "SA", "AE", "QA", "KW", "BH",
    "OM", "YE", "TR", "EG", "LY", "TN", "DZ", "MA", "SD",
    // South Asia folded in here: WION (the previous owner of this bucket)
    // doesn't embed, and no working India-specific alternative was found
    // in the 2026-09-09 sweep (Times Now and NDTV both failed the same
    // way). Al Jazeera's Global South coverage is the best real option
    // available, not a perfect regional match.
    "IN", "PK", "BD", "LK", "NP", "BT", "AF",
  ],
  france24: [
    "UA", "RU", "BY", "PL", "FR", "GB", "IT", "ES", "PT", "NL", "BE",
    "CH", "AT", "SE", "NO", "DK", "FI", "IE", "GR", "RO", "BG", "HU", "CZ",
    "SK", "RS", "HR", "BA", "MD", "GE", "AM", "AZ", "ML", "NE", "TD", "CF",
    "SN", "CI", "BF",
  ],
  // DE peeled off from France24's list — DW News is a real German
  // broadcaster (and confirmed embeddable), so Germany gets its own
  // dedicated feed instead of a French one covering it secondhand.
  dwnews: ["DE"],
  nbcnews: ["US", "CA", "AU", "NZ", "MX", "BR", "AR", "CL", "CO", "PE", "VE"],
  rappler: [
    // CNA's old bucket (CNA doesn't embed). Rappler is Philippines-based,
    // not a pan-Southeast-Asia broadcaster the way CNA aimed to be — kept
    // as the whole region's default anyway since it's the only confirmed-
    // working option this sweep found for it.
    "CN", "TW", "SG", "MY", "ID", "PH", "VN", "TH", "MM", "KH", "LA",
    "BN", "HK", "MO",
  ],
  nhkworld: ["JP", "KR", "KP"],
  africanews: [
    "NG", "ZA", "KE", "ET", "GH", "UG", "TZ", "ZW", "ZM", "MZ", "AO",
    "CM", "CD", "RW", "SO", "SS",
  ],
  // Manual-pick-only options — no auto-suggested countries.
  abcnews: [],
  cbsnews: [],
  bloomberg: [],
  trtworld: [],
};

const COUNTRY_TO_CHANNEL: Record<string, LiveChannelId> = Object.entries(
  REGION_MAP,
).reduce(
  (acc, [channel, countries]) => {
    for (const c of countries) acc[c] = channel as LiveChannelId;
    return acc;
  },
  {} as Record<string, LiveChannelId>,
);

// Given a selected country (ISO alpha-2 or null), suggest the live
// broadcaster most likely to be covering it. Always overridable in the UI.
export function suggestLiveChannel(country: string | null): LiveChannelId {
  if (!country) return DEFAULT_LIVE_CHANNEL;
  return COUNTRY_TO_CHANNEL[country] ?? DEFAULT_LIVE_CHANNEL;
}

export function liveEmbedUrl(channelId: string): string {
  return `https://www.youtube.com/embed/live_stream?channel=${channelId}&autoplay=1&mute=1`;
}
