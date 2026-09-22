import { unzipSync, strFromU8 } from "fflate";

// GeoNames populated places, the reference data behind the exposure model
// (2026-09-22). `cities15000` is every settlement over 15,000 people —
// 34,146 rows, a 3.3 MB zip, verified live.
//
// Why this and not a real population raster: GHSL and WorldPop publish
// the actually-correct thing, a gridded surface, in GeoTIFF files that
// run to gigabytes. This project has 370 MB of database headroom and no
// raster tooling, and the question being asked is coarse — "did this
// happen near people or not" — so a point set of settlements answers it
// at 0.1% of the storage. The cost is honesty about what it is: it
// undercounts dispersed rural population entirely, which is recorded in
// exposure.ts rather than hidden.
//
// License: Creative Commons Attribution 4.0 (checked in the dump's own
// readme.txt, 2026-09-22). Attribution is required and is recorded in
// docs/API_SOURCES.md.
const CITIES_ENDPOINT = "https://download.geonames.org/export/dump/cities15000.zip";
const REQUEST_TIMEOUT_MS = 120_000;

export interface PopulationCenter {
  geonameId: number;
  name: string;
  country: string; // ISO2
  lat: number;
  lon: number;
  population: number;
}

// Tab-separated, 19 columns, no header. The four that matter are fixed by
// GeoNames' published format: 1 id, 2 name, 5 lat, 6 lon, 9 country code,
// 15 population (1-indexed, as their readme numbers them).
const COL = { id: 0, name: 1, lat: 4, lon: 5, country: 8, population: 14 } as const;

export async function fetchPopulationCenters(): Promise<PopulationCenter[]> {
  let res: Response;
  try {
    res = await fetch(CITIES_ENDPOINT, {
      headers: { "User-Agent": "geopulse-globe/1.0" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`GeoNames request failed: ${err}`);
  }
  if (!res.ok) throw new Error(`GeoNames fetch failed: ${res.status}`);

  const zipped = new Uint8Array(await res.arrayBuffer());
  const files = unzipSync(zipped);
  const entry = files["cities15000.txt"];
  if (!entry) throw new Error("GeoNames zip did not contain cities15000.txt");

  const out: PopulationCenter[] = [];
  for (const line of strFromU8(entry).split("\n")) {
    if (!line.trim()) continue;
    const c = line.split("\t");
    const lat = Number(c[COL.lat]);
    const lon = Number(c[COL.lon]);
    const population = Number(c[COL.population]);
    const geonameId = Number(c[COL.id]);
    // A row with no usable coordinate or a zero population contributes
    // nothing to an exposure sum and would only cost a row to store.
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!Number.isFinite(population) || population <= 0) continue;
    if (!Number.isFinite(geonameId)) continue;
    out.push({
      geonameId,
      name: c[COL.name] ?? "",
      country: (c[COL.country] ?? "").toUpperCase(),
      lat,
      lon,
      population,
    });
  }
  if (out.length === 0) throw new Error("GeoNames parsed to zero population centers");
  return out;
}
