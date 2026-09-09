import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { detectAnomaly, DEFAULT_BASELINE_CONFIG, type AnomalyOutcome } from "@/lib/anomalyBaseline";

// Live-SQL anomaly signal — unlike every other signal in this system
// (aircraft, GPS jamming), there is no snapshot table here: `events`
// already has full timestamped history (published_at), so a day-bucketed
// count is just a GROUP BY away. This transitively covers IODA
// infrastructure-outage volume too, since those rows land in `events`
// with category "infrastructure-outage" exactly like any RSS/GDELT item —
// this is "rate of already-detected outages," not double-counting: IODA
// (src/lib/sources/ioda.ts) applies its own MIN_REPORTABLE_EVENT_COUNT
// floor before a row ever exists, this just asks "is that already-filtered
// rate itself unusual for this country."
//
// Buckets are ROLLING 24h windows relative to scan time (`now()`), not
// calendar days. This matters: the scan runs once daily as part of
// /api/admin/snapshot-flights, at whatever wall-clock time that cron
// actually fires — a calendar-day bucket would make "today" a partial day
// (however many hours have elapsed since UTC midnight) compared against
// full 24h baseline days, systematically biasing the latest bucket low
// regardless of any real change. `days_ago = floor((now - published_at) /
// 24h)` sidesteps this entirely: bucket 0 is always exactly the 24h
// ending at scan time, bucket 1 the 24h before that, and so on — every
// bucket the same width, none of them partial, independent of what time
// the cron happens to run.
const LOOKBACK_DAYS = 30;

interface DayBucketRow {
  country: string;
  category: string | null;
  daysAgo: number;
  cnt: number;
}

// Query-builder style matching risk.ts's getCountryCategoryRows exactly
// (real columns and computed sql<T> expressions mixed in one .select(),
// a raw sql WHERE combining conditions) rather than a fully raw
// db.execute() — this codebase has no precedent for the latter against
// typed rows (db.execute is only ever used for the DDL statements in
// /api/admin/migrate), so staying with the proven pattern here.
async function fetchDayBuckets(byCategory: boolean): Promise<DayBucketRow[]> {
  const db = getDb();
  const daysAgoExpr = sql<number>`floor(extract(epoch from (now() - ${events.publishedAt})) / 86400)::int`;

  const rows = await db
    .select({
      country: events.country,
      category: byCategory ? events.category : sql<string | null>`null`,
      daysAgo: daysAgoExpr,
      cnt: sql<number>`count(*)::int`,
    })
    .from(events)
    .where(
      sql`${events.country} is not null and ${events.reviewStatus} = 'approved' and ${events.publishedAt} > now() - interval '${sql.raw(String(LOOKBACK_DAYS + 1))} days'`,
    )
    .groupBy(
      ...(byCategory
        ? [events.country, events.category, daysAgoExpr]
        : [events.country, daysAgoExpr]),
    );

  return rows
    .filter((r): r is typeof r & { country: string } => r.country !== null)
    .map((r) => ({
      country: r.country,
      category: r.category,
      daysAgo: Number(r.daysAgo),
      cnt: Number(r.cnt),
    }));
}

export interface EventVolumeAnomaly {
  country: string;
  category: string | null;
  todayCount: number;
  baselineMean: number;
  baselineStdDev: number;
  sampleSize: number;
  jump: number;
  zScore: number;
}

// Many country×category cells are mostly zeros (e.g. humanitarian events
// in a quiet country) — a 0→3 jump on a near-zero baseline blows up the
// z-score the same way a MAD-based approach would (see anomalyBaseline.ts's
// doc comment). The country-level (all-categories-combined) signal is
// naturally denser and doesn't need this floor; the per-category signal
// does.
const CATEGORY_MIN_BASELINE_MEAN = 1;

export interface EventVolumeAnomalyOutcome {
  country: string;
  category: string | null;
  outcome: AnomalyOutcome;
}

// Returns EVERY country[/category] checked, not just the anomalous ones —
// used by anomalyScan.ts to also report insufficient-baseline counts.
// "Stale" is not a meaningful outcome for this signal specifically: unlike
// the snapshot-based signals (aircraft, GPS jamming), bucket 0 is defined
// as "the 24h ending at query time" (see the file header), so it is
// always exactly as fresh as the moment this function runs — there's no
// separate cron whose failure this freshness check could catch.
function toOutcomes(
  rows: DayBucketRow[],
  keyOf: (r: DayBucketRow) => string,
  config: Parameters<typeof detectAnomaly>[1],
): EventVolumeAnomalyOutcome[] {
  const byKey = new Map<string, { country: string; category: string | null; series: { value: number; at: Date }[] }>();
  const now = Date.now();
  for (const r of rows) {
    const key = keyOf(r);
    const entry = byKey.get(key) ?? { country: r.country, category: r.category, series: [] };
    // days_ago is relative to `now()` at query time — convert back to an
    // absolute Date so detectAnomaly's freshness gate (maxLatestAgeMs)
    // still means what it says regardless of how long ago this ran.
    entry.series.push({ value: r.cnt, at: new Date(now - r.daysAgo * 86_400_000) });
    byKey.set(key, entry);
  }

  const outcomes: EventVolumeAnomalyOutcome[] = [];
  for (const { country, category, series } of byKey.values()) {
    // Newest-first, matching every other signal's convention (detectAnomaly
    // treats the first element as "latest").
    series.sort((a, b) => b.at.getTime() - a.at.getTime());
    outcomes.push({ country, category, outcome: detectAnomaly(series, config) });
  }
  return outcomes;
}

function outcomesToAnomalies(outcomes: EventVolumeAnomalyOutcome[]): EventVolumeAnomaly[] {
  const anomalies: EventVolumeAnomaly[] = [];
  for (const { country, category, outcome } of outcomes) {
    if (outcome.status !== "anomaly") continue;
    anomalies.push({
      country,
      category,
      todayCount: outcome.data.observedValue,
      baselineMean: outcome.data.baselineMean,
      baselineStdDev: outcome.data.baselineStdDev,
      sampleSize: outcome.data.sampleSize,
      jump: outcome.data.jump,
      zScore: outcome.data.zScore,
    });
  }
  return anomalies.sort((a, b) => b.zScore - a.zScore);
}

export async function getEventVolumeAnomalyOutcomes(): Promise<EventVolumeAnomalyOutcome[]> {
  const rows = await fetchDayBuckets(false);
  return toOutcomes(rows, (r) => r.country, {
    ...DEFAULT_BASELINE_CONFIG,
    lookbackDays: LOOKBACK_DAYS,
  });
}

export async function getEventVolumeByCategoryAnomalyOutcomes(): Promise<EventVolumeAnomalyOutcome[]> {
  const rows = await fetchDayBuckets(true);
  return toOutcomes(rows, (r) => `${r.country}:${r.category}`, {
    ...DEFAULT_BASELINE_CONFIG,
    lookbackDays: LOOKBACK_DAYS,
    minBaselineMean: CATEGORY_MIN_BASELINE_MEAN,
  });
}

export async function getEventVolumeAnomalies(): Promise<EventVolumeAnomaly[]> {
  return outcomesToAnomalies(await getEventVolumeAnomalyOutcomes());
}

export async function getEventVolumeByCategoryAnomalies(): Promise<EventVolumeAnomaly[]> {
  return outcomesToAnomalies(await getEventVolumeByCategoryAnomalyOutcomes());
}
