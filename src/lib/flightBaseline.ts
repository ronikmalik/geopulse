import { sql, desc } from "drizzle-orm";
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

// Pure statistics, not ML — plain z-score against each country's own
// trailing history, same "honest baseline, no fabricated threshold" spirit
// as this table's own doc comment in src/db/schema.ts. Snapshots began
// 2026-09-03, so any given country only clears MIN_BASELINE_SAMPLES once
// its own daily cron has actually run that many times — this naturally
// self-activates per country over the following ~2 weeks rather than
// flagging anything off a handful of noisy data points today. Computed on
// read (no stored table), same "pure JS aggregation, not re-derived SQL"
// approach as risk.ts's getCountryCategoryRows.
export interface AircraftAnomaly {
  country: string;
  todayCount: number;
  baselineMean: number;
  baselineStdDev: number;
  sampleSize: number;
  zScore: number;
}

const ANOMALY_LOOKBACK_DAYS = 30;
// Two weeks of daily samples before trusting a mean/stddev estimate at
// all — fewer than this and a single unusual day would swing the
// baseline itself, not just flag against it.
const MIN_BASELINE_SAMPLES = 14;
// Conservative on purpose (see eventDedup.ts's SIMILARITY_THRESHOLD
// comment for the same precision-over-recall reasoning applied there) —
// this is a brand-new, uncalibrated signal with no real-world validation
// yet, so it should surface only genuinely large deviations at first.
const Z_SCORE_THRESHOLD = 2.5;
// Also require an absolute jump, not just a statistical one — a country
// whose baseline is "0 or 1 aircraft most days" can have a technically
// enormous z-score from a single-aircraft increase, which isn't a
// meaningful "surge" in the way this feature means it.
const MIN_ABSOLUTE_JUMP = 2;
// Guards against flagging off a stale row if a day's snapshot cron never
// fired — "today's count" should actually be recent.
const MAX_LATEST_AGE_MS = 36 * 60 * 60_000;

export async function getAircraftAnomalies(): Promise<AircraftAnomaly[]> {
  const db = getDb();
  const rows = await db
    .select({
      country: aircraftCountHistory.country,
      count: aircraftCountHistory.count,
      snapshotAt: aircraftCountHistory.snapshotAt,
    })
    .from(aircraftCountHistory)
    .where(
      sql`${aircraftCountHistory.snapshotAt} > now() - interval '${sql.raw(String(ANOMALY_LOOKBACK_DAYS))} days'`,
    )
    .orderBy(desc(aircraftCountHistory.snapshotAt));

  const byCountry = new Map<string, { count: number; snapshotAt: Date }[]>();
  for (const r of rows) {
    const list = byCountry.get(r.country) ?? [];
    list.push({ count: r.count, snapshotAt: r.snapshotAt });
    byCountry.set(r.country, list);
  }

  const anomalies: AircraftAnomaly[] = [];
  for (const [country, samples] of byCountry) {
    // samples is already sorted newest-first (query orderBy desc).
    const [latest, ...baseline] = samples;
    if (!latest || baseline.length < MIN_BASELINE_SAMPLES) continue;
    if (Date.now() - latest.snapshotAt.getTime() > MAX_LATEST_AGE_MS) continue;

    const mean = baseline.reduce((sum, b) => sum + b.count, 0) / baseline.length;
    const variance =
      baseline.reduce((sum, b) => sum + (b.count - mean) ** 2, 0) / (baseline.length - 1);
    const stdDev = Math.sqrt(variance);

    const jump = latest.count - mean;
    if (jump < MIN_ABSOLUTE_JUMP) continue;
    // stdDev === 0 means a perfectly flat baseline just moved — a real
    // anomaly, but "divide by zero" isn't a number JSON can carry, so it's
    // reported as a capped sentinel (99) rather than Infinity.
    const zScore = stdDev > 0 ? Math.min(99, jump / stdDev) : 99;
    if (zScore < Z_SCORE_THRESHOLD) continue;

    anomalies.push({
      country,
      todayCount: latest.count,
      baselineMean: Math.round(mean * 10) / 10,
      baselineStdDev: Math.round(stdDev * 10) / 10,
      sampleSize: baseline.length,
      zScore: Math.round(zScore * 10) / 10,
    });
  }

  return anomalies.sort((a, b) => b.zScore - a.zScore);
}
