import { getDb } from "@/db";
import { events } from "@/db/schema";
import { and, inArray, isNull, sql } from "drizzle-orm";
import {
  EXPOSURE_WEIGHTED_CATEGORIES,
  describeNearestPlace,
  loadPopulationCenters,
  loadPopulationCentersNear,
  populationNear,
  isExposureWeighted,
  type NamedCenter,
} from "@/lib/exposure";

// Geographic enrichment for events, run after every ingest (the
// review-pending job) and re-runnable by hand as `backfill-exposure`.
// Two jobs, one pass, because both need the settlements near an event:
//
//  1. population_exposed for hazard events (exposure.ts). Until
//     2026-09-23 this only ever ran as a one-off backfill, so every hazard
//     ingested after 2026-09-22 carried NULL — scored at a neutral 1 —
//     and the exposure model was quietly fading out of the score as the
//     backfilled events aged past the 30-day window.
//  2. A readable place label for events whose only location is a pair of
//     coordinates. On 2026-09-23, 42 of the 100 cards in the live feed
//     were headlined "-2.92, 112.60" (NASA FIRMS fire detections).
//
// Self-terminating: each pass takes rows still needing work, and doing
// the work removes them from that set.

const BATCH_SIZE = 2000;
// Above this many pending events it is cheaper to read every settlement
// once than to send one bounding box per event.
const BBOX_LIMIT = 200;

// FIRMS writes `${lat.toFixed(2)}, ${lon.toFixed(2)}`; nothing else in
// the pipeline produces a label of this shape.
const COORDINATE_LABEL_SQL = `'^-?[0-9]+\\.[0-9]+, -?[0-9]+\\.[0-9]+$'`;

const regionNames =
  typeof Intl !== "undefined" ? new Intl.DisplayNames(["en"], { type: "region" }) : null;

function countryLabel(iso2: string | null): string | null {
  if (!iso2) return null;
  try {
    return regionNames?.of(iso2) ?? iso2;
  } catch {
    return iso2;
  }
}

function hasUsableCoordinates(lat: number, lon: number): boolean {
  // 0,0 is the null island every geocoding pipeline produces when it has
  // nothing; counting the Gulf of Guinea's population for it would be
  // worse than recording no exposure at all.
  return Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0);
}

export function placeLabelFor(
  lat: number,
  lon: number,
  country: string | null,
  centers: NamedCenter[],
): string | null {
  const place = describeNearestPlace(lat, lon, centers);
  const countryText = countryLabel(country);
  if (place) {
    // The nearest town can sit across a border: a fire in Bolivia 95 km
    // from La Rinconada must not read as if La Rinconada were Bolivian.
    const across = country && place.center.country !== country ? ` (${countryLabel(place.center.country)})` : "";
    const text = `${place.text}${across}`;
    return countryText ? `${text}, ${countryText}` : text;
  }
  // Nothing of 15,000+ within 100 km: say so rather than invent a
  // neighbour. Without a country either, the caller keeps the coordinates.
  return countryText ? `Remote area, ${countryText}` : null;
}

export interface ExposureBackfillResult {
  markedNotApplicable: number;
  scanned: number;
  updated: number;
  relabeled: number;
  centersRead: number;
  remaining: number;
}

export async function backfillEventExposure(): Promise<ExposureBackfillResult> {
  const db = getDb();
  const cats = sql.raw([...EXPOSURE_WEIGHTED_CATEGORIES].map((c) => `'${c}'`).join(", "));

  // Everything that can never have an exposure figure is settled in one
  // statement, without reading a single settlement. -1 is the "checked,
  // not applicable" sentinel exposureMultiplier treats as neutral.
  const notApplicable = await db
    .update(events)
    .set({ populationExposed: -1 })
    .where(
      and(
        isNull(events.populationExposed),
        sql`(${events.category} not in (${cats}) or (${events.lat} = 0 and ${events.lon} = 0))`,
      ),
    )
    .returning({ id: events.id });

  const rows = await db
    .select({
      id: events.id,
      lat: events.lat,
      lon: events.lon,
      category: events.category,
      country: events.country,
      location: events.location,
      populationExposed: events.populationExposed,
    })
    .from(events)
    .where(sql`${events.populationExposed} is null or ${events.location} ~ ${sql.raw(COORDINATE_LABEL_SQL)}`)
    .limit(BATCH_SIZE);

  if (rows.length === 0) {
    return { markedNotApplicable: notApplicable.length, scanned: 0, updated: 0, relabeled: 0, centersRead: 0, remaining: 0 };
  }

  const usable = rows.filter((r) => hasUsableCoordinates(r.lat, r.lon));
  const centers: NamedCenter[] =
    usable.length > BBOX_LIMIT
      ? await loadPopulationCenters()
      : await loadPopulationCentersNear(usable);

  // Group ids by the value being written so one UPDATE covers many rows:
  // exposure values repeat heavily, and a per-row update of a large
  // backfill would be thousands of round trips on a metered database.
  const byValue = new Map<number, number[]>();
  const labels: { id: number; label: string }[] = [];
  const coordinateLabel = /^-?\d+\.\d+, -?\d+\.\d+$/;
  for (const r of rows) {
    const ok = hasUsableCoordinates(r.lat, r.lon);
    if (r.populationExposed === null && isExposureWeighted(r.category)) {
      const value = ok ? populationNear(r.lat, r.lon, centers) : -1;
      const list = byValue.get(value) ?? [];
      list.push(r.id);
      byValue.set(value, list);
    }
    if (coordinateLabel.test(r.location)) {
      // Always rewritten, even when there is nothing better to say, so the
      // row leaves the coordinate-label set and is never picked up again.
      const label = (ok && placeLabelFor(r.lat, r.lon, r.country, centers)) || `Remote area (${r.location})`;
      labels.push({ id: r.id, label });
    }
  }

  let updated = 0;
  for (const [value, ids] of byValue) {
    for (let i = 0; i < ids.length; i += 500) {
      const slice = ids.slice(i, i + 500);
      await db
        .update(events)
        .set({ populationExposed: value })
        .where(and(inArray(events.id, slice), isNull(events.populationExposed)));
      updated += slice.length;
    }
  }

  // One statement per 500 labels via UPDATE ... FROM (VALUES ...), for
  // the same round-trip reason.
  for (let i = 0; i < labels.length; i += 500) {
    const values = sql.join(
      labels.slice(i, i + 500).map((l) => sql`(${l.id}::int, ${l.label}::text)`),
      sql`, `,
    );
    await db.execute(
      sql`update ${events} set location = v.label from (values ${values}) as v(id, label) where ${events.id} = v.id`,
    );
  }

  const [left] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(events)
    .where(isNull(events.populationExposed));

  return {
    markedNotApplicable: notApplicable.length,
    scanned: rows.length,
    updated,
    relabeled: labels.length,
    centersRead: centers.length,
    remaining: left?.n ?? 0,
  };
}
