import { getDb } from "@/db";
import { events } from "@/db/schema";
import { and, inArray, isNull, sql } from "drizzle-orm";
import { loadPopulationCenters, populationNear, isExposureWeighted } from "@/lib/exposure";

// Fills population_exposed for events that predate the exposure model
// (2026-09-22). Re-runnable and self-terminating: each pass takes the
// next slice of rows where the column is still NULL, so running it until
// it reports 0 is the whole procedure.
//
// Only the categories the risk engine actually weights are computed. The
// scan is cheap but not free (34k settlements per event), and storing a
// head count next to a coup would invite somebody to start weighting it
// later, which is exactly the bias exposure.ts refuses.

const BATCH_SIZE = 2000;

export interface ExposureBackfillResult {
  scanned: number;
  updated: number;
  remaining: number;
}

export async function backfillEventExposure(): Promise<ExposureBackfillResult> {
  const db = getDb();
  const centers = await loadPopulationCenters();
  if (centers.length === 0) {
    throw new Error("population_center is empty — run the load-population-centers job first");
  }

  const rows = await db
    .select({ id: events.id, lat: events.lat, lon: events.lon, category: events.category })
    .from(events)
    .where(isNull(events.populationExposed))
    .limit(BATCH_SIZE);

  let updated = 0;
  // Group ids by the value being written so one UPDATE covers many rows:
  // a per-row update of 8,000 events is 8,000 round trips on a metered
  // database, and exposure values repeat heavily (every event with no
  // usable coordinate shares one).
  const byValue = new Map<number, number[]>();
  for (const r of rows) {
    const usable =
      isExposureWeighted(r.category) &&
      Number.isFinite(r.lat) &&
      Number.isFinite(r.lon) &&
      // 0,0 is the null island every geocoding pipeline produces when it
      // has nothing; counting the Gulf of Guinea's population for it
      // would be worse than recording no exposure at all.
      !(r.lat === 0 && r.lon === 0);
    // -1 is the sentinel for "checked, not applicable" so a re-run does
    // not keep picking these rows up forever. It reads as null to
    // exposureMultiplier's own guard, which only trusts values >= 0.
    const value = usable ? populationNear(r.lat, r.lon, centers) : -1;
    const list = byValue.get(value) ?? [];
    list.push(r.id);
    byValue.set(value, list);
  }

  for (const [value, ids] of byValue) {
    for (let i = 0; i < ids.length; i += 500) {
      await db
        .update(events)
        .set({ populationExposed: value })
        .where(inArray(events.id, ids.slice(i, i + 500)));
      updated += Math.min(500, ids.length - i);
    }
  }

  const [left] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(events)
    .where(and(isNull(events.populationExposed)));

  return { scanned: rows.length, updated, remaining: left?.n ?? 0 };
}
