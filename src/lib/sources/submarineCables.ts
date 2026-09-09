// Submarine cable infrastructure — TeleGeography's public
// submarinecablemap.com API, no key, no auth.
// https://www.submarinecablemap.com/api/v3/
//
// Checked live 2026-09-08: the per-cable detail endpoint
// (`/api/v3/cable/{id}.json`) DOES carry a clean, structured
// `landing_points[].country` field, but there's no bulk "all cables with
// full detail" endpoint — getting that field for all ~707 cables would
// mean 707 individual requests, which isn't reasonable for a layer route
// fetched on every panel open (even cached). There's also no fault/outage/
// status field anywhere in this API — it's static infrastructure
// metadata (owners, RFS date, landing points), not a live status feed, so
// a "current cable cuts" layer isn't actually buildable from this source
// despite that being the more newsworthy signal (Baltic/Red Sea/Taiwan
// Strait cable-cut incidents are real and recent, just not exposed here).
//
// What IS bulk-fetchable in one request: `landing-point/landing-point-geo.json`,
// every landing point's display name as "<City>, <Country>" (1925 points).
// Parsing the country back out of that string (rather than hitting a
// per-point detail endpoint per point) is the only way to get a full
// country breakdown in one request; COMPOUND_COUNTRY_SUFFIXES below
// exists because a handful of country names (DR Congo, Republic of the
// Congo, confirmed live) themselves contain a comma, so "take the last
// comma-separated segment" needs a short list of exceptions checked first.
// Country name spelling is then matched against COUNTRY_CENTROIDS' names
// (case-insensitive) via COUNTRY_NAME_ALIASES for the common spelling
// mismatches between the two datasets (e.g. "Congo, Dem. Rep." vs this
// app's "DR Congo") — anything still unmatched is dropped from the
// per-country ranking (not silently mis-attributed) but still counted in
// the global totals, so the ranking undercounts landing points rather
// than ever showing a wrong country.
//
// Framing: this is landing-point COUNT, a proxy for connectivity
// redundancy, not a live risk signal — a country with very few landings
// is more exposed to a single cable-cut disrupting its connectivity, one
// with many has more redundancy. Ranked descending (most-connected first)
// for consistency with every other "top N" ticker in this app; the
// vulnerability reading is the inverse of this list, not a separate sort.
import { COUNTRY_CENTROIDS } from "../countryCentroids";

const CABLE_LIST_URL = "https://www.submarinecablemap.com/api/v3/cable/all.json";
const LANDING_POINT_GEO_URL =
  "https://www.submarinecablemap.com/api/v3/landing-point/landing-point-geo.json";
const REQUEST_TIMEOUT_MS = 15_000;

// Confirmed live 2026-09-08: these are the only landing-point country
// names in this dataset whose own name contains a comma. Checked longest-
// first isn't necessary since neither is a substring of the other, but
// order doesn't matter here regardless.
const COMPOUND_COUNTRY_SUFFIXES = ["Congo, Dem. Rep.", "Congo, Rep."];

// Spelling mismatches between submarinecablemap.com's country names and
// this app's COUNTRY_CENTROIDS names, found by a live diff of the two
// lists. Not exhaustive — anything not listed here and not an exact
// (case-insensitive) match to a COUNTRY_CENTROIDS name is dropped from
// the ranking rather than guessed at.
const COUNTRY_NAME_ALIASES: Record<string, string> = {
  "congo, dem. rep.": "DR Congo",
  "congo, rep.": "Republic of the Congo",
  "korea, rep.": "South Korea",
  "korea, dem. people's rep.": "North Korea",
  "cote d'ivoire": "Ivory Coast",
  "côte d'ivoire": "Ivory Coast",
  myanmar: "Myanmar",
  "russian federation": "Russia",
  "viet nam": "Vietnam",
  "syrian arab republic": "Syria",
  "iran, islamic rep. of": "Iran",
  "venezuela, rb": "Venezuela",
  "tanzania, u. rep. of": "Tanzania",
  "micronesia, fed. sts.": "Micronesia",
  "brunei darussalam": "Brunei",
  "lao pdr": "Laos",
  "bolivia (plurinational state of)": "Bolivia",
};

let nameToIso2Cache: Map<string, string> | null = null;
function nameToIso2(rawName: string): string | null {
  if (!nameToIso2Cache) {
    nameToIso2Cache = new Map();
    for (const [iso2, c] of Object.entries(COUNTRY_CENTROIDS)) {
      nameToIso2Cache.set(c.name.toLowerCase(), iso2);
    }
  }
  const lower = rawName.toLowerCase();
  const aliased = COUNTRY_NAME_ALIASES[lower];
  const key = (aliased ?? rawName).toLowerCase();
  return nameToIso2Cache.get(key) ?? null;
}

function countryFromLandingPointName(name: string): string {
  for (const suffix of COMPOUND_COUNTRY_SUFFIXES) {
    if (name.endsWith(suffix)) return suffix;
  }
  const parts = name.split(",");
  return parts[parts.length - 1].trim();
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { "User-Agent": "geopulse-globe/1.0" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`submarine cable fetch failed for ${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

interface LandingPointGeoResponse {
  features: { properties: { id: string; name: string } }[];
}

export interface CableCountryExposure {
  countryIso2: string;
  countryName: string;
  landingPointCount: number;
}

export interface SubmarineCableSummary {
  totalCables: number;
  totalLandingPoints: number;
  topCountries: CableCountryExposure[];
}

export async function fetchSubmarineCableSummary(
  topN = 10,
): Promise<SubmarineCableSummary | null> {
  const [cables, landingPoints] = await Promise.all([
    fetchJson<{ id: string }[]>(CABLE_LIST_URL),
    fetchJson<LandingPointGeoResponse>(LANDING_POINT_GEO_URL),
  ]);

  const countsByIso2 = new Map<string, number>();
  for (const feature of landingPoints.features) {
    const countryName = countryFromLandingPointName(feature.properties.name);
    const iso2 = nameToIso2(countryName);
    if (!iso2) continue;
    countsByIso2.set(iso2, (countsByIso2.get(iso2) ?? 0) + 1);
  }

  const topCountries: CableCountryExposure[] = [...countsByIso2.entries()]
    .map(([countryIso2, landingPointCount]) => ({
      countryIso2,
      countryName: COUNTRY_CENTROIDS[countryIso2].name,
      landingPointCount,
    }))
    .sort((a, b) => b.landingPointCount - a.landingPointCount)
    .slice(0, topN);

  return {
    totalCables: cables.length,
    totalLandingPoints: landingPoints.features.length,
    topCountries,
  };
}
