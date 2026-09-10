import { sql, desc, eq, and } from "drizzle-orm";
import { getDb } from "@/db";
import { aircraftCountHistory } from "@/db/schema";
import { fetchAdsbLolMilitary, fetchAdsbLolCommercial } from "@/lib/sources/adsblol";
import { countryFromLatLon } from "@/lib/geoResolve";
import { detectAnomaly, DEFAULT_BASELINE_CONFIG, type AnomalyOutcome } from "@/lib/anomalyBaseline";

export type AircraftKind = "military" | "commercial";

// Snapshots today's currently-tracked aircraft, bucketed by reverse-
// geocoded country, into aircraft_count_history — the first step toward
// the "surge above baseline" detection described in docs/OSINT_SOURCES.md.
// Aircraft that resolve to no country (open ocean, international
// airspace) are excluded: this table is a per-country baseline, not a
// global count, and a real anomaly detector needs several weeks of these
// snapshots before it has anything honest to compare a given day against.
// Called by /api/admin/snapshot-flights on the daily cron defined in
// vercel.ts.
async function snapshotAircraft(
  kind: AircraftKind,
  aircraft: { lat: number; lon: number }[],
): Promise<{ inserted: number; countriesSeen: number }> {
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
    kind,
  }));

  const db = getDb();
  const result = await db
    .insert(aircraftCountHistory)
    .values(rows)
    .returning({ id: aircraftCountHistory.id });

  return { inserted: result.length, countriesSeen: countsByCountry.size };
}

export async function snapshotAircraftCounts(): Promise<{ inserted: number; countriesSeen: number }> {
  return snapshotAircraft("military", await fetchAdsbLolMilitary());
}

// Commercial coverage is real but narrow — fetchAdsbLolCommercial samples
// 9 fixed geopolitical hub points (London, Frankfurt, Istanbul, Dubai, Tel
// Aviv, Moscow, DC, Hong Kong, Seoul) at 250nm radius, not global traffic
// (see adsblol.ts's own doc comment). A commercial-flight anomaly for a
// given country is only ever meaningful for countries near one of those
// hubs; a country whose airspace sits between two overlapping hubs (e.g.
// UK/France near London+Frankfurt) has counts shaped by adsblol.ts's own
// cross-hub dedup, not a true regional total. Same honesty standard that
// file already holds its live layer to, extended to this historical use.
export async function snapshotCommercialAircraftCounts(): Promise<{
  inserted: number;
  countriesSeen: number;
}> {
  return snapshotAircraft("commercial", await fetchAdsbLolCommercial());
}

// Pure statistics, not ML — plain z-score against each country's own
// trailing history, same "honest baseline, no fabricated threshold" spirit
// as this table's own doc comment in src/db/schema.ts. Snapshots began
// 2026-09-03, so any given country only clears the baseline sample
// requirement once its own daily cron has actually run that many times —
// this naturally self-activates per country over the following ~2 weeks
// rather than flagging anything off a handful of noisy data points today.
// Computed on read (no stored table), same "pure JS aggregation, not
// re-derived SQL" approach as risk.ts's getCountryCategoryRows.
//
// Commercial counts use allowNegativeJump — a large DROP (an airspace
// closure) is the meaningful signal for commercial traffic, unlike
// military presence where only a rise matters. This is the one signal in
// the whole anomaly system where a decrease, not an increase, is flagged.
const ANOMALY_LOOKBACK_DAYS = 30;

export interface AircraftAnomalyOutcome {
  country: string;
  outcome: AnomalyOutcome;
}

// Returns EVERY country checked, not just the anomalous ones — anomalyScan.ts
// filters this down to just the actual findings, but also reports
// insufficient-baseline/stale counts from the unfiltered set.
export async function getAircraftAnomalyOutcomes(kind: AircraftKind): Promise<AircraftAnomalyOutcome[]> {
  const db = getDb();
  const rows = await db
    .select({
      country: aircraftCountHistory.country,
      count: aircraftCountHistory.count,
      snapshotAt: aircraftCountHistory.snapshotAt,
    })
    .from(aircraftCountHistory)
    .where(
      and(
        eq(aircraftCountHistory.kind, kind),
        sql`${aircraftCountHistory.snapshotAt} > now() - interval '${sql.raw(String(ANOMALY_LOOKBACK_DAYS))} days'`,
      ),
    )
    .orderBy(desc(aircraftCountHistory.snapshotAt));

  const byCountry = new Map<string, { value: number; at: Date }[]>();
  for (const r of rows) {
    const list = byCountry.get(r.country) ?? [];
    list.push({ value: r.count, at: r.snapshotAt });
    byCountry.set(r.country, list);
  }

  const outcomes: AircraftAnomalyOutcome[] = [];
  for (const [country, samples] of byCountry) {
    // samples is already sorted newest-first (query orderBy desc).
    const outcome = detectAnomaly(samples, {
      ...DEFAULT_BASELINE_CONFIG,
      lookbackDays: ANOMALY_LOOKBACK_DAYS,
      allowNegativeJump: kind === "commercial",
    });
    outcomes.push({ country, outcome });
  }
  return outcomes;
}
