import { getDb } from "@/db";
import { populationCenter } from "@/db/schema";
import { sql } from "drizzle-orm";
import { fetchPopulationCenters } from "@/lib/sources/geonames";
import type { Category } from "@/lib/categories";

// Severity is not impact (2026-09-22).
//
// Until now a magnitude-6 earthquake under an empty stretch of desert
// scored exactly like a magnitude-6 under a capital city, because the
// risk engine reads severity and nothing else. That has been the most
// obvious analytical hole in the product since hazard sources were
// wired: USGS, GDACS, EONET and FIRMS all report how big something was,
// never how much it mattered.
//
// This module supplies the missing half: how many people are near the
// coordinates. It is deliberately crude and the crudeness is documented
// rather than dressed up — see the caveats below.

// Settlements within this distance count toward an event's exposure.
// 100 km is roughly the radius over which a large earthquake is felt
// destructively, and it is the wrong number for a wildfire and for a
// flood. One radius for every hazard is a simplification this accepts
// for now; a per-category radius is the obvious next refinement.
const EXPOSURE_RADIUS_KM = 100;

// Only these categories get weighted. The rule is narrow on purpose: a
// hazard's human cost genuinely depends on who lives underneath it,
// whereas a coup, a border incident or a humanitarian emergency does NOT
// matter less because it happened in a less crowded country. Weighting
// political news by population would encode "events in big countries
// matter more", which is a bias, not a correction.
export const EXPOSURE_WEIGHTED_CATEGORIES: ReadonlySet<string> = new Set<Category>([
  "earthquake",
  "natural-disaster",
  "climate-hazard",
]);

export function isExposureWeighted(category: string): boolean {
  return EXPOSURE_WEIGHTED_CATEGORIES.has(category);
}

const EARTH_RADIUS_KM = 6371;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

interface Center {
  lat: number;
  lon: number;
  population: number;
}

// 34k rows at ~24 bytes each is under a megabyte of process memory, and
// loading them once beats issuing a bounding-box query per event — the
// backfill alone would otherwise be 8,000 round trips to a database on a
// metered compute plan.
let cache: Center[] | null = null;

export async function loadPopulationCenters(): Promise<Center[]> {
  if (cache) return cache;
  const db = getDb();
  const rows = await db
    .select({
      lat: populationCenter.lat,
      lon: populationCenter.lon,
      population: populationCenter.population,
    })
    .from(populationCenter);
  cache = rows;
  return cache;
}

export function resetPopulationCache(): void {
  cache = null;
}

// Population within EXPOSURE_RADIUS_KM, linearly de-weighted by distance
// so a city on the far edge of the circle counts for little and one at
// the epicentre counts fully. Returns a plain head count, not a score —
// the number stored on the event is meant to be readable as "roughly
// this many people live near where this happened".
//
// Known to undercount: rural population living outside any settlement of
// 15,000+ does not appear in the source data at all. A hazard in a
// densely-farmed but un-urbanised region therefore reads as emptier than
// it is. This biases the model toward under-weighting, which is the safer
// direction: it can make a real event look ordinary, but it cannot invent
// a crisis where nobody lives.
export function populationNear(lat: number, lon: number, centers: Center[]): number {
  // Cheap pre-filter before the trigonometry: one degree of latitude is
  // ~111 km everywhere, so anything outside this band cannot qualify.
  const latBand = EXPOSURE_RADIUS_KM / 111;
  const lonBand = latBand / Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  let total = 0;
  for (const c of centers) {
    if (Math.abs(c.lat - lat) > latBand) continue;
    let dLon = Math.abs(c.lon - lon);
    if (dLon > 180) dLon = 360 - dLon; // antimeridian
    if (dLon > lonBand) continue;
    const d = haversineKm(lat, lon, c.lat, c.lon);
    if (d > EXPOSURE_RADIUS_KM) continue;
    total += c.population * (1 - d / EXPOSURE_RADIUS_KM);
  }
  return Math.round(total);
}

// Turns a head count into a multiplier on an event's severity weight.
//
// ANCHOR_POPULATION is the exposure that scores exactly 1.0, i.e. the
// level at which this model neither promotes nor demotes an event. It is
// set to the measured median exposure of the hazard events already in the
// database, so switching the model on leaves the typical event where it
// was and only moves the genuinely empty and the genuinely crowded. That
// is why this number is empirical rather than chosen: see
// docs/ARCHITECTURE.md for the measurement.
// Measured 2026-09-22 over all 2,174 hazard events in the database that
// carry usable coordinates: p10 0, p25 0, MEDIAN 10,375, p75 67,363,
// p90 388,350, max 43.9M. 864 of those 2,174 — 40% — sit at exactly
// zero, which is the finding that justifies this whole model: they are
// earthquakes out at sea, thermal anomalies over empty forest, and
// hurricanes still over water, and until now every one of them scored
// like the same event in a city.
const ANCHOR_POPULATION = 10_000;
const MIN_MULTIPLIER = 0.4;
const MAX_MULTIPLIER = 1.6;
// How fast the multiplier moves per decade of population. 0.3 means a
// 10x more crowded place scores 0.3 higher, so the full range spans
// roughly four orders of magnitude.
const DECADE_STEP = 0.3;

// The master switch. Off means every weight in the app is exactly what
// it was before this model existed — the column still fills, so the data
// accumulates and the comparison can be re-run, but nothing a user sees
// moves. A code constant rather than an environment variable on purpose:
// this changes published risk scores, so which state it was in on a given
// day has to be answerable from the commit history, not from whatever two
// separate dashboards happened to be set to.
export const EXPOSURE_WEIGHTING_ENABLED = true;

// The same curve as exposureMultiplier below, as a SQL fragment, because
// the weight it multiplies is summed in Postgres over thousands of rows
// (getCountryCategoryRows) and pulling those into JS to multiply them
// would cost far more than duplicating one formula.
//
// Built from the same constants as the JS version so the two cannot drift
// apart in the numbers — only in the algebra, which the regression test
// pins by checking both against the same hand-computed values.
export function exposureMultiplierSqlExpr(columnSql: string, categorySql: string): string {
  const cats = [...EXPOSURE_WEIGHTED_CATEGORIES].map((c) => `'${c}'`).join(", ");
  return `(case when ${categorySql} in (${cats}) and ${columnSql} is not null and ${columnSql} >= 0
      then least(${MAX_MULTIPLIER}, greatest(${MIN_MULTIPLIER},
        1 + ${DECADE_STEP} * log(10, ((${columnSql} + 1)::numeric / ${ANCHOR_POPULATION}))))
      else 1 end)`;
}

export function exposureMultiplier(populationExposed: number | null): number {
  // Null means "not computed" — an event inserted before this model
  // existed. Negative is the backfill's "checked, not applicable"
  // sentinel: no usable coordinates, or a category this model refuses to
  // weight. Both mean the same thing here and both return a neutral 1.
  //
  // This guard is load-bearing. Without the `< 0` arm the sentinel would
  // fall through to log10(0), clamp to MIN_MULTIPLIER, and silently
  // demote every event whose coordinates were missing — turning "we do
  // not know" into "this did not matter".
  if (populationExposed === null || !Number.isFinite(populationExposed)) return 1;
  if (populationExposed < 0) return 1;
  const ratio = (populationExposed + 1) / ANCHOR_POPULATION;
  const raw = 1 + DECADE_STEP * Math.log10(ratio);
  return Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, raw));
}

export interface PopulationLoadResult {
  fetched: number;
  written: number;
}

// One-off, re-runnable. GeoNames revises the dump continuously, but
// settlement locations and populations move on a scale of years, so this
// is not scheduled — it is run when somebody wants the reference data
// refreshed.
export async function loadPopulationCentersFromSource(): Promise<PopulationLoadResult> {
  const db = getDb();
  const centers = await fetchPopulationCenters();

  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < centers.length; i += CHUNK) {
    const chunk = centers.slice(i, i + CHUNK);
    await db
      .insert(populationCenter)
      .values(chunk)
      .onConflictDoUpdate({
        target: populationCenter.geonameId,
        set: {
          name: sql`excluded.name`,
          country: sql`excluded.country`,
          lat: sql`excluded.lat`,
          lon: sql`excluded.lon`,
          population: sql`excluded.population`,
        },
      });
    written += chunk.length;
  }
  resetPopulationCache();
  return { fetched: centers.length, written };
}
