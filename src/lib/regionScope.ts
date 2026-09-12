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

// 2026-09-09: the full-country-coverage audit added 32 countries to
// countryCentroids.ts/countryNames.ts (see those files' own comments) but
// this file's region sets were never updated to match — a real,
// self-inflicted regression discovered right after: a country resolving
// fine but missing from its geographic region's Set here means
// isCountryInSourceRegion silently REJECTS a legitimate, in-theater story
// from the exact regional specialist outlet that should be covering it
// (e.g. AllAfrica correctly reporting on Benin would have been dropped).
// Every one of the 32 newly-tracked countries is added below to whichever
// region set it actually belongs to.
const ASIA_PACIFIC = new Set([
  "AF", "AU", "BD", "CN", "FJ", "ID", "IN", "JP", "KG", "KH", "KP", "KR",
  "KZ", "LA", "LK", "MM", "MN", "MV", "MY", "NC", "NP", "NZ", "PG", "PH",
  "PK", "SB", "SG", "TH", "TJ", "TM", "TO", "TW", "UZ", "VN", "VU",
  "BT", "BN", "KI", "MH", "FM", "NR", "PW", "WS", "TL", "TV",
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
  "AO", "BJ", "BF", "KM", "GQ", "GM", "GW", "ST", "SC",
]);

const LATIN_AMERICA = new Set([
  "AR", "BO", "BR", "BS", "BZ", "CL", "CO", "CR", "CU", "DO", "EC", "GT",
  "HN", "HT", "JM", "MX", "NI", "PA", "PE", "PR", "PY", "SV", "TT", "UY",
  "VE",
  "AG", "BB", "DM", "GD", "GY", "KN", "LC", "VC",
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
  "rss:haaretz": "middle-east",
  "rss:allafrica": "africa",
  "rss:premium-times-nigeria": "africa",
  "rss:africanews": "africa",
  "rss:african-arguments": "africa",
  "rss:daily-maverick": "africa",
  "rss:rappler-philippines": "asia-pacific",
  "rss:tempo-indonesia": "asia-pacific",
  "rss:buenos-aires-times": "latin-america",
  // malaysiakini and rnz-pacific were both added to rss.ts after this file
  // was originally written and never wired in here — found during the
  // 2026-09-09 full-country-coverage audit. Neither missing entry hid any
  // content (an unscoped source defaults to unrestricted, the opposite
  // failure mode from the one this file exists to catch), but both are
  // genuinely single-theater specialists this file's own stated purpose
  // says should be scoped like every other one above.
  "rss:malaysiakini": "asia-pacific",
  "rss:rnz-pacific": "asia-pacific",
  // rss:new-humanitarian is deliberately NOT scoped here, unlike the two
  // above — it's explicitly a cross-cutting outlet by design (Sahel, Horn
  // of Africa, Sudan, Myanmar, Central Asia simultaneously; see rss.ts's
  // own comment), spanning at least three of this file's four regions.
  // Forcing it into any single Region would incorrectly reject its
  // legitimate reporting on every region but the one chosen — worse than
  // leaving it unscoped.
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
