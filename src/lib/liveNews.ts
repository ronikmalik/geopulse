// Live televised news coverage — a curated set of verified 24/7
// international broadcast channels, embedded via YouTube's channel-live
// endpoint (resolves to whatever that broadcaster currently has on air, no
// video-ID juggling required). Every channel ID below was verified against
// that broadcaster's own YouTube channel (not guessed) — see the commit
// that introduced this file for the verification trail. This is
// deliberately NOT tied to any single flashpoint: picking a broadcaster is
// about which live feed is most likely to be covering a given region right
// now, not which of the five default categories a country belongs to.
export interface LiveChannel {
  id: string; // YouTube channel ID (UC...)
  name: string;
  region: string;
}

export const LIVE_CHANNELS: Record<string, LiveChannel> = {
  aljazeera: {
    id: "UCNye-wNBqNL5ZzHSJj3l8Bg",
    name: "Al Jazeera English",
    region: "Middle East / Global South",
  },
  france24: {
    id: "UCQfwfsi5VrQ8yKZ-UWmAEFg",
    name: "France 24 English",
    region: "Europe / Africa / Francophone world",
  },
  dwnews: {
    id: "UCknLrEdhRCp1aegoMqRaCZg",
    name: "DW News",
    region: "Europe / Germany",
  },
  skynews: {
    id: "UCoMdktPbSTixAyNGwb-UYkQ",
    name: "Sky News",
    region: "Global / UK",
  },
  cna: {
    id: "UC83jt4dlz1Gjl58fzQrrKZg",
    name: "CNA",
    region: "Southeast Asia",
  },
  nhkworld: {
    id: "UCSPEjw8F2nQDtmUKPFNF7_A",
    name: "NHK World-Japan",
    region: "East Asia / Japan",
  },
  wion: {
    id: "UC_gUM8rL-Lrg6O3adPW9K1g",
    name: "WION",
    region: "South Asia / India",
  },
  africanews: {
    id: "UC1_E8NeF5QHY2dtdLRBCCLA",
    name: "Africanews",
    region: "Africa",
  },
};

export type LiveChannelId = keyof typeof LIVE_CHANNELS;

export const DEFAULT_LIVE_CHANNEL: LiveChannelId = "skynews";

// Country (ISO alpha-2) -> broadcaster whose live feed is most likely to
// actually be covering that country right now. Deliberately broad regional
// buckets, not a country-by-country lookup for all ~195 countries — the
// goal is "reasonable default, always overridable," not exhaustive.
const REGION_MAP: Record<LiveChannelId, string[]> = {
  aljazeera: [
    "IL", "PS", "IR", "IQ", "SY", "LB", "JO", "SA", "AE", "QA", "KW", "BH",
    "OM", "YE", "TR", "EG", "LY", "TN", "DZ", "MA", "SD",
  ],
  france24: [
    "UA", "RU", "BY", "PL", "FR", "DE", "GB", "IT", "ES", "PT", "NL", "BE",
    "CH", "AT", "SE", "NO", "DK", "FI", "IE", "GR", "RO", "BG", "HU", "CZ",
    "SK", "RS", "HR", "BA", "MD", "GE", "AM", "AZ", "ML", "NE", "TD", "CF",
    "SN", "CI", "BF",
  ],
  dwnews: [],
  skynews: ["US", "CA", "AU", "NZ", "MX", "BR", "AR", "CL", "CO", "PE", "VE"],
  cna: [
    "CN", "TW", "SG", "MY", "ID", "PH", "VN", "TH", "MM", "KH", "LA",
    "BN", "HK", "MO",
  ],
  nhkworld: ["JP", "KR", "KP"],
  wion: ["IN", "PK", "BD", "LK", "NP", "BT", "AF"],
  africanews: [
    "NG", "ZA", "KE", "ET", "GH", "UG", "TZ", "ZW", "ZM", "MZ", "AO",
    "CM", "CD", "RW", "SO", "SS",
  ],
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
