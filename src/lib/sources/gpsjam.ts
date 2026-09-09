// GPS/GNSS jamming — gpsjam.org publishes a daily global aggregate of
// aircraft ADS-B-derived GPS interference (an aircraft reporting a GPS fix
// confidence below a threshold counts as "bad" for the H3 cell it's in),
// no key, no auth. https://gpsjam.org
//
// The per-day detail file (`{date}-h3_4.csv`) is H3-resolution-4 cell IDs
// with good/bad aircraft counts — NOT a country or region name. Getting a
// genuinely useful "where is this happening" signal out of it requires
// decoding each cell to a lat/lon and reverse-matching it against a known
// point, which is exactly what a raw hex ID can't give you for free. That
// reverse-match is worth a real dependency: `h3-js` (Apache-2.0, zero
// transitive deps, the standard decoder for Uber's H3 grid — same
// "small, well-known, single-purpose library" bar this project already
// cleared for rss-parser/topojson-client) rather than hand-rolling H3's
// hex-grid math here. A global "N suspect hexes today" number with no
// geography would be honest but nearly useless for a product whose whole
// point is showing WHERE risk is concentrated — Persian Gulf/Black Sea/
// Baltic jamming clusters are a real, current, geopolitically meaningful
// pattern this dataset can actually surface.
//
// Country attribution is nearest-capital-centroid (COUNTRY_CENTROIDS),
// same approximation already used elsewhere in this codebase (see that
// file's own doc comment) — but here it's reverse geocoding a raw
// coordinate rather than just planting a point for an already-known
// country, a meaningfully rougher use of the same technique. A cell
// hundreds of km from the nearest capital (open ocean, remote jamming near
// a contested strait rather than over a landmass) is dropped rather than
// force-attributed to whichever coastal capital happens to be closest —
// MAX_ATTRIBUTION_KM below draws that line. Treat the resulting country
// ranking as "which country's territory/waters this cluster is nearest
// to," not a confirmed national attribution.
import { cellToLatLng } from "h3-js";
import { COUNTRY_CENTROIDS } from "../countryCentroids";

const MANIFEST_URL = "https://gpsjam.org/data/manifest.csv";
const DETAIL_URL_BASE = "https://gpsjam.org/data";
const REQUEST_TIMEOUT_MS = 15_000;

// Cells further than this from every known capital are dropped rather
// than attributed to a nearest-but-still-far country — see file header.
const MAX_ATTRIBUTION_KM = 800;
const EARTH_RADIUS_KM = 6371;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.asin(Math.sqrt(a));
}

function nearestCountry(
  lat: number,
  lon: number,
): { iso2: string; name: string } | null {
  let best: { iso2: string; name: string; distKm: number } | null = null;
  for (const [iso2, c] of Object.entries(COUNTRY_CENTROIDS)) {
    const distKm = haversineKm(lat, lon, c.lat, c.lon);
    if (!best || distKm < best.distKm) best = { iso2, name: c.name, distKm };
  }
  if (!best || best.distKm > MAX_ATTRIBUTION_KM) return null;
  return { iso2: best.iso2, name: best.name };
}

export interface JammedRegion {
  countryIso2: string;
  countryName: string;
  badCellCount: number;
  badAircraftCount: number;
}

export interface GpsJammingSummary {
  date: string;
  globalSuspect: boolean;
  totalBadHexes: number;
  regions: JammedRegion[];
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "geopulse-globe/1.0" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`gpsjam fetch failed for ${url}: ${res.status}`);
  return res.text();
}

interface ManifestRow {
  date: string;
  suspect: boolean;
  numBadAircraftHexes: number;
}

function parseManifest(manifestText: string): ManifestRow[] {
  return manifestText
    .trim()
    .split("\n")
    .slice(1) // drop header
    .map((line) => {
      const [date, suspect, numBadAircraftHexes] = line.split(",");
      return { date, suspect: suspect === "true", numBadAircraftHexes: Number(numBadAircraftHexes) };
    })
    .filter((r) => r.date);
}

// Manifest rows aren't guaranteed sorted, and "today" (UTC) is frequently
// still processing upstream (a live check found the most recent 1-2 dates
// occasionally missing their detail file even though listed in the
// manifest) — walk backward from the latest listed date and use the first
// one whose detail file actually resolves, rather than trusting the last
// row blindly. Returns the manifest's own fields for the date it actually
// picked, so the caller never needs a second manifest fetch/parse (and
// never has to re-derive "which row is latest" itself, avoiding the same
// unsorted-manifest bug this function exists to guard against).
async function fetchLatestDetail(): Promise<
  (ManifestRow & { rows: string[] }) | null
> {
  const manifestText = await fetchText(MANIFEST_URL);
  const byDateDesc = parseManifest(manifestText).sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
  );

  for (const manifestRow of byDateDesc.slice(0, 5)) {
    try {
      const detailText = await fetchText(
        `${DETAIL_URL_BASE}/${manifestRow.date}-h3_4.csv`,
      );
      const rows = detailText.trim().split("\n").slice(1);
      return { ...manifestRow, rows };
    } catch {
      continue; // try the previous day
    }
  }
  return null;
}

export async function fetchGpsJammingSummary(topN = 10): Promise<GpsJammingSummary | null> {
  const detail = await fetchLatestDetail();
  if (!detail) return null;

  const byCountry = new Map<string, JammedRegion>();

  for (const row of detail.rows) {
    const [hex, , badStr] = row.split(",");
    const bad = Number(badStr);
    if (!hex || !Number.isFinite(bad) || bad <= 0) continue;

    const [lat, lon] = cellToLatLng(hex);
    const match = nearestCountry(lat, lon);
    if (!match) continue;

    const existing = byCountry.get(match.iso2);
    if (existing) {
      existing.badCellCount++;
      existing.badAircraftCount += bad;
    } else {
      byCountry.set(match.iso2, {
        countryIso2: match.iso2,
        countryName: match.name,
        badCellCount: 1,
        badAircraftCount: bad,
      });
    }
  }

  const regions = [...byCountry.values()]
    .sort((a, b) => b.badAircraftCount - a.badAircraftCount)
    .slice(0, topN);

  return {
    date: detail.date,
    globalSuspect: detail.suspect,
    totalBadHexes: detail.numBadAircraftHexes,
    regions,
  };
}
