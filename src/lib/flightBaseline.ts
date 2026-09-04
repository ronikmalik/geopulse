import { getDb } from "@/db";
import { aircraftCountHistory } from "@/db/schema";
import { fetchAdsbLolMilitary } from "@/lib/sources/adsblol";
import { countryFromLatLon } from "@/lib/geoResolve";

// Snapshots today's currently-tracked military aircraft, bucketed by
// reverse-geocoded country, into aircraft_count_history — the first step
// toward the "surge above baseline" detection described in
// docs/OSINT_SOURCES.md. Aircraft that resolve to no country (open ocean,
// international airspace) are excluded: this table is a per-country
// baseline, not a global count, and a real anomaly detector needs
// several weeks of these snapshots before it has anything honest to
// compare a given day against. Called by /api/admin/snapshot-flights on
// the daily cron defined in vercel.ts.
export async function snapshotAircraftCounts(): Promise<{ inserted: number; countriesSeen: number }> {
  const aircraft = await fetchAdsbLolMilitary();

  const countsByCountry = new Map<string, number>();
  for (const a of aircraft) {
    const country = countryFromLatLon(a.lat, a.lon);
    if (!country) continue;
    countsByCountry.set(country, (countsByCountry.get(country) ?? 0) + 1);
  }

  if (countsByCountry.size === 0) return { inserted: 0, countriesSeen: 0 };

  const rows = Array.from(countsByCountry.entries()).map(([country, count]) => ({
    country,
    count,
  }));

  const db = getDb();
  const result = await db
    .insert(aircraftCountHistory)
    .values(rows)
    .returning({ id: aircraftCountHistory.id });

  return { inserted: result.length, countriesSeen: countsByCountry.size };
}
