// User request (2026-09-05): "keep the rss news feed that comes from rss
// sources from asia pacific, middle east, africa, latin america dedicated
// to those geographic boundaries... premium times should not be getting
// used for news in america. it should be dedicated to its theater."
//
// The problem this closes: classifyByKeywords resolves a story's country
// from its own text (resolveCountryFromText in countryNames.ts), entirely
// independent of which outlet published it. A regional specialist outlet
// occasionally wire-carries or opines on a story well outside its own
// beat (Premium Times — Nigeria's paper — running a piece that happens to
// center on the US) would previously get inserted as a real US event
// sourced from a Nigerian outlet, which is a category error: these
// outlets were chosen specifically for deep, credible coverage of their
// own theater (see docs/SOURCE_CREDIBILITY.md), not as general-purpose
// global wires. General/global wires (BBC, Guardian, NYT, NPR, CBS, DW,
// France24, Euronews, RFE/RL, ABC Australia, CBC, Meduza, Moscow Times,
// TWZ, Long War Journal) are deliberately NOT scoped here — restricting
// them the same way would be wrong, since global coverage is exactly
// their job.
//
// Country sets are continent-level, not single-country — Premium Times
// covering Kenya (a different African country) is still legitimately
// "its theater"; only cross-continent leakage is the actual problem
// being fixed. Built from every ISO code present in countryCentroids.ts,
// grouped by common geopolitical usage. A few borderline cases (Turkey,
// North Africa) are intentionally double-counted between two regions
// (e.g. Egypt reads as both "Middle East" and "Africa" in ordinary usage)
// rather than forced into one — a false negative (wrongly dropping a
// real in-theater story) is worse here than the minor overlap.
export type Region = "asia-pacific" | "middle-east" | "africa" | "latin-america";

const ASIA_PACIFIC = new Set([
  "AF", "AU", "BD", "CN", "FJ", "ID", "IN", "JP", "KG", "KH", "KP", "KR",
  "KZ", "LA", "LK", "MM", "MN", "MV", "MY", "NC", "NP", "NZ", "PG", "PH",
  "PK", "SB", "SG", "TH", "TJ", "TM", "TO", "TW", "UZ", "VN", "VU",
]);

const MIDDLE_EAST = new Set([
  "AE", "BH", "DZ", "EG", "IL", "IQ", "IR", "JO", "KW", "LB", "LY", "MA",
  "OM", "PS", "QA", "SA", "SY", "TN", "TR", "YE",
]);

const AFRICA = new Set([
  "BI", "BW", "CD", "CF", "CG", "CI", "CM", "CV", "DJ", "DZ", "EG", "ER",
  "ET", "GA", "GH", "GN", "KE", "LR", "LS", "LY", "MA", "MG", "ML", "MR",
  "MU", "MW", "MZ", "NA", "NE", "NG", "RW", "SD", "SL", "SN", "SO", "SS",
  "SZ", "TD", "TG", "TN", "TZ", "UG", "ZA", "ZM", "ZW",
]);

const LATIN_AMERICA = new Set([
  "AR", "BO", "BR", "BS", "BZ", "CL", "CO", "CR", "CU", "DO", "EC", "GT",
  "HN", "HT", "JM", "MX", "NI", "PA", "PE", "PR", "PY", "SV", "TT", "UY",
  "VE",
]);

const REGION_COUNTRIES: Record<Region, Set<string>> = {
  "asia-pacific": ASIA_PACIFIC,
  "middle-east": MIDDLE_EAST,
  africa: AFRICA,
  "latin-america": LATIN_AMERICA,
};

// Keyed by the exact `source` string RawItem carries (`rss:<feed-name>`,
// see src/lib/sources/rss.ts). Only the outlets already grouped under an
// "Asia-Pacific" / "Middle East" / "Africa" / "Latin America" comment
// block in RSS_FEEDS are scoped — general/global wires are deliberately
// left out, see the file-level comment above.
const RSS_SOURCE_REGION: Record<string, Region> = {
  "rss:cna-world": "asia-pacific",
  "rss:the-hindu": "asia-pacific",
  "rss:taipei-times": "asia-pacific",
  "rss:nknews": "asia-pacific",
  "rss:rfa": "asia-pacific",
  "rss:yonhap": "asia-pacific",
  "rss:al-monitor": "middle-east",
  "rss:times-of-israel": "middle-east",
  "rss:haaretz": "middle-east",
  "rss:allafrica": "africa",
  "rss:premium-times-nigeria": "africa",
  "rss:africanews": "africa",
  "rss:buenos-aires-times": "latin-america",
};

// True when `source` isn't region-scoped at all (a general/global wire,
// or a non-RSS source like GDELT/Telegram), or when it is and `country`
// falls inside that region's set. False means: a regional specialist
// outlet ran a story about a country outside its own theater — drop it,
// don't attribute it to that outlet.
export function isCountryInSourceRegion(source: string, country: string): boolean {
  const region = RSS_SOURCE_REGION[source];
  if (!region) return true;
  return REGION_COUNTRIES[region].has(country.toUpperCase());
}
