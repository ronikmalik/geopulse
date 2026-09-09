// STANDALONE / NOT INTEGRATED into the events table — see
// src/lib/sources/README.md. US State Department Travel Advisories, no API
// key required, plain RSS.
// https://travel.state.gov/content/travel/en/traveladvisories/traveladvisories.html
//
// Two other government feeds were checked live before settling on this one
// alone (2026-09-08): Australia's DFAT Smartraveller RSS
// (smartraveller.gov.au/countries/documents/index.rss) timed out/never
// resolved from this environment — genuinely unreachable, not just slow.
// UK FCDO's Atom feed (gov.uk/foreign-travel-advice.atom) IS live, but it's
// a "what changed recently" changelog ("Updated information about visa
// requirements...") with no discrete risk level per entry at all — a
// structurally different shape from State Dept's clean "Level 1-4", not
// just a different scale. Forcing it into the same shape would mean
// fabricating a level State Dept and FCDO didn't publish, so it's left out
// entirely rather than integrated badly. State Dept alone already covers
// essentially every country with a clean, structured level — exactly the
// "prefer simplicity when the single feed already works" call.
const FEED_URL = "https://travel.state.gov/_res/rss/TAsTWs.xml";

export interface TravelAdvisory {
  country: string; // ISO 3166-1 alpha-2
  countryName: string;
  level: 1 | 2 | 3 | 4;
  levelLabel: string; // e.g. "Reconsider Travel"
  url: string;
}

// The feed's own <category domain="Country-Tag"> values are State
// Department-internal codes (FIPS 10-4-derived, e.g. "NS" for Suriname,
// "TP" for São Tomé and Príncipe) that do NOT match ISO 3166-1 — mapping
// those would need a second lookup table just as large as this one, for no
// real benefit. The title's country name is unambiguous plain English and
// State Dept uses a small, stable set of exact names, so this map is keyed
// directly on those (lowercased) rather than on the Country-Tag codes.
// Built 2026-09-08 from every distinct name a live fetch of the full feed
// actually produced — not guessed from a generic country list — so it's
// exactly the set this parser needs to resolve, no more, no less. A name
// this map doesn't recognize (the feed adds/renames destinations rarely
// but not never) is dropped rather than guessed at.
const COUNTRY_NAME_TO_ALPHA2: Record<string, string> = {
  afghanistan: "AF", albania: "AL", algeria: "DZ", andorra: "AD",
  angola: "AO", anguilla: "AI", antarctica: "AQ",
  "antigua and barbuda": "AG", argentina: "AR", armenia: "AM",
  aruba: "AW", australia: "AU", austria: "AT", azerbaijan: "AZ",
  bahrain: "BH", bangladesh: "BD", barbados: "BB", belarus: "BY",
  belgium: "BE", belize: "BZ", benin: "BJ", bermuda: "BM", bhutan: "BT",
  bolivia: "BO", bonaire: "BQ", "bosnia and herzegovina": "BA",
  botswana: "BW", brazil: "BR", "british virgin islands": "VG",
  brunei: "BN", bulgaria: "BG", "burkina faso": "BF", burma: "MM",
  burundi: "BI", "cabo verde": "CV", cambodia: "KH", cameroon: "CM",
  canada: "CA", "cayman islands": "KY", "central african republic": "CF",
  chad: "TD", chile: "CL", colombia: "CO", comoros: "KM",
  "costa rica": "CR", "cote d ivoire": "CI", croatia: "HR", cuba: "CU",
  "curaçao": "CW", curacao: "CW", cyprus: "CY", czechia: "CZ",
  "democratic republic of the congo": "CD", djibouti: "DJ",
  dominica: "DM", "dominican republic": "DO", ecuador: "EC",
  egypt: "EG", "el salvador": "SV", "equatorial guinea": "GQ",
  eritrea: "ER", estonia: "EE", eswatini: "SZ", ethiopia: "ET",
  "federated states of micronesia": "FM", fiji: "FJ", finland: "FI",
  france: "FR", "french guiana": "GF", "french polynesia": "PF",
  gabon: "GA", gaza: "PS", georgia: "GE", germany: "DE", ghana: "GH",
  greece: "GR", greenland: "GL", grenada: "GD", guadeloupe: "GP",
  guatemala: "GT", guinea: "GN", "guinea-bissau": "GW", guyana: "GY",
  haiti: "HT", honduras: "HN", "hong kong": "HK", hungary: "HU",
  iceland: "IS", india: "IN", indonesia: "ID", iran: "IR", iraq: "IQ",
  ireland: "IE", israel: "IL", italy: "IT", jamaica: "JM", japan: "JP",
  jordan: "JO", kazakhstan: "KZ", kenya: "KE",
  "kingdom of denmark": "DK", kiribati: "KI", kosovo: "XK",
  kuwait: "KW", laos: "LA", latvia: "LV", lebanon: "LB", lesotho: "LS",
  liberia: "LR", libya: "LY", liechtenstein: "LI", lithuania: "LT",
  luxembourg: "LU", macau: "MO", madagascar: "MG", malawi: "MW",
  malaysia: "MY", maldives: "MV", malta: "MT", "marshall islands": "MH",
  martinique: "MQ", mauritania: "MR", mauritius: "MU", mexico: "MX",
  moldova: "MD", mongolia: "MN", montenegro: "ME", montserrat: "MS",
  morocco: "MA", mozambique: "MZ", namibia: "NA", nauru: "NR",
  nepal: "NP", netherlands: "NL", "new caledonia": "NC",
  "new zealand": "NZ", nicaragua: "NI", niger: "NE", nigeria: "NG",
  "north macedonia": "MK", norway: "NO", oman: "OM", pakistan: "PK",
  palau: "PW", panama: "PA", "papua new guinea": "PG", paraguay: "PY",
  peru: "PE", philippines: "PH", poland: "PL", portugal: "PT",
  qatar: "QA", "republic of the congo": "CG", romania: "RO",
  russia: "RU", rwanda: "RW", "saint barthelemy": "BL",
  "saint kitts and nevis": "KN", "saint lucia": "LC",
  "saint vincent and the grenadines": "VC", samoa: "WS",
  "sao tome and principe": "ST", "saudi arabia": "SA", senegal: "SN",
  serbia: "RS", seychelles: "SC", "sierra leone": "SL",
  singapore: "SG", "sint maarten": "SX", slovakia: "SK",
  slovenia: "SI", "solomon islands": "SB", somalia: "SO",
  "south africa": "ZA", "south korea": "KR", "south sudan": "SS",
  spain: "ES", "sri lanka": "LK", sudan: "SD", suriname: "SR",
  sweden: "SE", switzerland: "CH", syria: "SY", taiwan: "TW",
  tajikistan: "TJ", tanzania: "TZ", thailand: "TH",
  "the bahamas": "BS", "the gambia": "GM", "the kyrgyz republic": "KG",
  "timor-leste": "TL", togo: "TG", tonga: "TO",
  "trinidad and tobago": "TT", tunisia: "TN", turkey: "TR",
  turkmenistan: "TM", "turks and caicos islands": "TC", tuvalu: "TV",
  uganda: "UG", ukraine: "UA", "united arab emirates": "AE",
  "united kingdom": "GB", uruguay: "UY", uzbekistan: "UZ",
  vanuatu: "VU", venezuela: "VE", vietnam: "VN", "west bank": "PS",
  yemen: "YE", zambia: "ZM", zimbabwe: "ZW",
};

const LEVEL_LABELS: Record<number, string> = {
  1: "Exercise Normal Precautions",
  2: "Exercise Increased Caution",
  3: "Reconsider Travel",
  4: "Do Not Travel",
};

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

// State Dept titles are almost always "<Country> - Level N: <reason>", but
// a handful of real entries don't fit: "Mexico Travel Advisory" (no level
// in the title at all — the level still comes from the Threat-Level
// category below, just not this string) and multi-country summary pages
// ("Mainland China, Hong Kong & Macau - See Summaries", no numeric level,
// filtered out by the caller before this is even reached). Stripping both
// known suffixes independently, rather than requiring one exact format,
// keeps the parser from silently dropping a real country over a title
// quirk.
function extractCountryName(title: string): string {
  return decodeBasicEntities(title)
    .split(/\s*-\s*Level\s*\d/i)[0]
    .replace(/\s*Travel Advisory\s*$/i, "")
    .trim();
}

interface RawAdvisoryItem {
  title: string;
  link: string;
  level: number | null;
}

// Hand-rolled block parsing rather than rss-parser: the signal this feed
// actually needs — the Threat-Level and Country-Tag <category domain="...">
// attributes — isn't something rss-parser's simple string-array category
// handling exposes (it drops the domain attribute), and this feed's
// structure is regular enough that splitting on <item> is safe, the same
// call telegram.ts already makes for its own attribute-bearing HTML.
function parseItems(xml: string): RawAdvisoryItem[] {
  const items: RawAdvisoryItem[] = [];
  const blocks = xml.split("<item>").slice(1);
  for (const block of blocks) {
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const levelCategoryMatch = block.match(
      /<category domain="Threat-Level">([\s\S]*?)<\/category>/,
    );
    if (!titleMatch) continue;

    const levelNumMatch = levelCategoryMatch?.[1].match(/Level\s*(\d)/i);
    items.push({
      title: titleMatch[1],
      link: linkMatch ? decodeBasicEntities(linkMatch[1]) : "",
      level: levelNumMatch ? Number(levelNumMatch[1]) : null,
    });
  }
  return items;
}

let cachedAdvisories: TravelAdvisory[] | null = null;
let cachedAt = 0;
const IN_MEMORY_CACHE_MS = 60 * 60_000;

// Fetches and parses the full feed once, cached in-memory for an hour
// (this route is also wrapped in withCache at the API layer for the HTTP
// response itself — this second, longer-lived cache exists because
// fetchTravelAdvisoryFor below is called once PER country-click, and
// re-fetching/re-parsing the whole ~200-entry feed on every single country
// click would be wasteful when the underlying data only changes a few
// times a week).
async function getAllAdvisories(): Promise<TravelAdvisory[]> {
  if (cachedAdvisories && Date.now() - cachedAt < IN_MEMORY_CACHE_MS) {
    return cachedAdvisories;
  }

  let res: Response;
  try {
    res = await fetch(FEED_URL, {
      headers: { "User-Agent": "geopulse-globe/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(`Travel advisory request failed: ${err}`);
  }
  if (!res.ok) {
    console.error(`Travel advisory fetch failed: ${res.status}`);
    return cachedAdvisories ?? [];
  }

  const xml = await res.text();
  const raw = parseItems(xml);

  const advisories: TravelAdvisory[] = [];
  for (const item of raw) {
    if (item.level == null || item.level < 1 || item.level > 4) continue;
    const countryName = extractCountryName(item.title);
    const iso2 = COUNTRY_NAME_TO_ALPHA2[countryName.toLowerCase()];
    if (!iso2) continue;
    advisories.push({
      country: iso2,
      countryName,
      level: item.level as 1 | 2 | 3 | 4,
      levelLabel: LEVEL_LABELS[item.level],
      url: item.link,
    });
  }

  cachedAdvisories = advisories;
  cachedAt = Date.now();
  return advisories;
}

// Top-N ticker view — countries currently at the two most serious levels,
// worst first. Ties (same level) keep the feed's own order, which is
// alphabetical by country, not meaningfully rankable further than the
// level itself (State Dept doesn't publish a finer-grained score).
export async function fetchElevatedAdvisories(limit = 15): Promise<TravelAdvisory[]> {
  const all = await getAllAdvisories();
  return all
    .filter((a) => a.level >= 3)
    .sort((a, b) => b.level - a.level)
    .slice(0, limit);
}

// Single-country lookup for the country-click dossier — mirrors
// src/lib/sources/forex.ts's fetchUsdRateFor dual-shape pattern (a curated
// ranked list for the ticker, plus an on-demand single lookup for the
// dossier, both backed by the same one fetch+parse pass here).
export async function fetchTravelAdvisoryFor(iso2: string): Promise<TravelAdvisory | null> {
  const all = await getAllAdvisories();
  return all.find((a) => a.country === iso2.toUpperCase()) ?? null;
}
