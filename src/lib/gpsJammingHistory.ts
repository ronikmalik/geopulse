import { sql, desc } from "drizzle-orm";
import { getDb } from "@/db";
import { gpsJammingHistory } from "@/db/schema";
import { fetchGpsJammingSummary } from "@/lib/sources/gpsjam";
import { detectAnomaly, DEFAULT_BASELINE_CONFIG, type AnomalyOutcome } from "@/lib/anomalyBaseline";

// Same "record it now, judge it later" pattern as flightBaseline.ts —
// snapshots today's per-country jammed-cell/aircraft counts so a real
// baseline builds up over the following ~2 weeks. gpsjam.ts's own
// fetchGpsJammingSummary defaults to topN=10 for the live display layer
// (a short "worst offenders today" list is all that UI needs) — a
// baseline needs every matched country every day, not just whichever ones
// happen to rank in the top 10 that day, so this calls it with a topN
// large enough to be effectively unbounded (there are ~195-200 countries
// total). Called by /api/admin/snapshot-flights on the daily cron.
const SNAPSHOT_TOP_N = 250;

export async function snapshotGpsJamming(): Promise<{ inserted: number; countriesSeen: number }> {
  const summary = await fetchGpsJammingSummary(SNAPSHOT_TOP_N);
  if (!summary || summary.regions.length === 0) return { inserted: 0, countriesSeen: 0 };

  const rows = summary.regions.map((r) => ({
    country: r.countryIso2,
    badCellCount: r.badCellCount,
    badAircraftCount: r.badAircraftCount,
  }));

  const db = getDb();
  const result = await db
    .insert(gpsJammingHistory)
    .values(rows)
    .returning({ id: gpsJammingHistory.id });

  return { inserted: result.length, countriesSeen: rows.length };
}

export interface GpsJammingAnomaly {
  country: string;
  todayBadCellCount: number;
  baselineMean: number;
  baselineStdDev: number;
  sampleSize: number;
  jump: number;
  zScore: number;
}

const ANOMALY_LOOKBACK_DAYS = 30;

export interface GpsJammingAnomalyOutcome {
  country: string;
  outcome: AnomalyOutcome;
}

// Returns EVERY country checked, not just the anomalous ones — used by
// anomalyScan.ts to also report insufficient-baseline/stale counts.
export async function getGpsJammingAnomalyOutcomes(): Promise<GpsJammingAnomalyOutcome[]> {
  const db = getDb();
  const rows = await db
    .select({
      country: gpsJammingHistory.country,
      badCellCount: gpsJammingHistory.badCellCount,
      snapshotAt: gpsJammingHistory.snapshotAt,
    })
    .from(gpsJammingHistory)
    .where(
      sql`${gpsJammingHistory.snapshotAt} > now() - interval '${sql.raw(String(ANOMALY_LOOKBACK_DAYS))} days'`,
    )
    .orderBy(desc(gpsJammingHistory.snapshotAt));

  const byCountry = new Map<string, { value: number; at: Date }[]>();
  for (const r of rows) {
    const list = byCountry.get(r.country) ?? [];
    list.push({ value: r.badCellCount, at: r.snapshotAt });
    byCountry.set(r.country, list);
  }

  const outcomes: GpsJammingAnomalyOutcome[] = [];
  for (const [country, samples] of byCountry) {
    const outcome = detectAnomaly(samples, {
      ...DEFAULT_BASELINE_CONFIG,
      lookbackDays: ANOMALY_LOOKBACK_DAYS,
    });
    outcomes.push({ country, outcome });
  }
  return outcomes;
}

export async function getGpsJammingAnomalies(): Promise<GpsJammingAnomaly[]> {
  const outcomes = await getGpsJammingAnomalyOutcomes();
  const anomalies: GpsJammingAnomaly[] = [];
  for (const { country, outcome } of outcomes) {
    if (outcome.status !== "anomaly") continue;
    anomalies.push({
      country,
      todayBadCellCount: outcome.data.observedValue,
      baselineMean: outcome.data.baselineMean,
      baselineStdDev: outcome.data.baselineStdDev,
      sampleSize: outcome.data.sampleSize,
      jump: outcome.data.jump,
      zScore: outcome.data.zScore,
    });
  }
  return anomalies.sort((a, b) => b.zScore - a.zScore);
}
