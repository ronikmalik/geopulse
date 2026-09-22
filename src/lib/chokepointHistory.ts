import { getDb } from "@/db";
import { chokepointTransitHistory } from "@/db/schema";
import { desc, sql, getTableColumns } from "drizzle-orm";
import { fetchChokepointTransitHistory } from "@/lib/sources/portwatch";
import {
  detectAnomaly,
  DEFAULT_BASELINE_CONFIG,
  type AnomalyOutcome,
} from "@/lib/anomalyBaseline";

// Maritime chokepoint disruption as a country-level signal (2026-09-22).
//
// IMF PortWatch has been fetched here since 2026-09-08 and thrown away
// after display: src/lib/sources/portwatch.ts's own header says a raw
// transit count means nothing without each chokepoint's own baseline, and
// that no history was kept to build one. This module keeps that history
// and turns it into the seventh signal of the daily anomaly scan.
//
// Nothing new is fetched on the ingest path and no new schedule is added:
// the snapshot rides `snapshot-flights`, the job that already runs the
// anomaly scan. The only marginal cost is one upsert of ~28 rows a day.

// PortWatch publishes weekly (Tuesdays, from satellite AIS), so the most
// recent day available routinely lags "today" by several days — a
// staleness rule tuned for a daily cron would flag the whole signal stale
// every week between publications. Ten days tolerates one missed weekly
// publication; two missed ones genuinely is a broken source.
const MAX_LATEST_AGE_MS = 10 * 24 * 60 * 60_000;

// Four times the 30-day baseline this signal actually reads, which is
// enough to widen the lookback later without re-fetching, and ~3,400 rows
// (well under 1 MB) against a 500 MB database. Upstream holds daily rows
// back to 2019 and it was tempting to keep a year for seasonality, but
// nothing here reads seasonality yet — storing it now would be hoarding
// against the one budget that is actually scarce. Re-fetching more later
// costs one paged read of someone else's table.
const CHOKEPOINT_RETENTION_DAYS = 120;

// How far back a run reaches when the window is not fully covered. Same
// as retention: there is no reason to fetch rows the prune would drop.
const BACKFILL_DAYS = CHOKEPOINT_RETENTION_DAYS;

// Below this share of the window's days actually present, a run refetches
// the whole window instead of just the recent tail.
const COVERAGE_TARGET = 0.8;

const ANOMALY_LOOKBACK_DAYS = 30;

// Each chokepoint's littoral states, so a disruption lands on the country
// risk picture where a reader would look for it — a Hormuz closure is an
// Iran/Oman/UAE signal, not an unattributed dot in the ocean. Kept as an
// explicit hand-checked table rather than derived by reverse-geocoding
// the coordinates: a strait is by definition the water BETWEEN countries,
// so a nearest-land lookup would pick one shore arbitrarily and silently
// drop the other. Every entry below is the set of states whose territory
// or territorial waters the passage runs through, read off PortWatch's
// own published coordinates.
//
// Deliberately conservative: only states that physically front the
// passage, never states that merely depend on it economically. "Who is
// hurt by a Hormuz closure" is a much longer list and a different
// question — one the exposure model, not this mapping, should answer.
export const CHOKEPOINT_COUNTRIES: Record<string, string[]> = {
  "Suez Canal": ["EG"],
  "Panama Canal": ["PA"],
  "Bosporus Strait": ["TR"],
  "Bab el-Mandeb Strait": ["YE", "DJ"],
  "Malacca Strait": ["MY", "ID", "SG"],
  "Strait of Hormuz": ["IR", "OM", "AE"],
  "Cape of Good Hope": ["ZA"],
  "Gibraltar Strait": ["ES", "MA"],
  "Dover Strait": ["GB", "FR"],
  "Oresund Strait": ["DK", "SE"],
  "Taiwan Strait": ["TW", "CN"],
  "Korea Strait": ["KR", "JP"],
  "Tsugaru Strait": ["JP"],
  "Luzon Strait": ["PH", "TW"],
  "Lombok Strait": ["ID"],
  "Ombai Strait": ["TL", "ID"],
  "Bohai Strait": ["CN"],
  "Torres Strait": ["AU", "PG"],
  "Sunda Strait": ["ID"],
  "Makassar Strait": ["ID"],
  "Magellan Strait": ["CL"],
  "Yucatan Channel": ["MX", "CU"],
  "Windward Passage": ["CU", "HT"],
  "Mona Passage": ["DO"],
  "Balabac Strait": ["PH", "MY"],
  "Bering Strait": ["US", "RU"],
  "Mindoro Strait": ["PH"],
  "Kerch Strait": ["RU", "UA"],
};

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60_000).toISOString().slice(0, 10);
}

export interface ChokepointSnapshotResult {
  fetched: number;
  written: number;
  pruned: number;
  backfilled: boolean;
}

// Upserts every day PortWatch currently reports inside the retention
// window, then prunes past it. Upsert rather than insert because
// PortWatch revises recent days as new satellite passes land — the same
// (chokepoint, date) can legitimately come back with a different count,
// and the newer figure is the better one.
//
// The first run does the full backfill; later runs only need the recent
// tail, but asking for a wider window than necessary is cheap (one
// paged read of a small upstream table) and self-heals any gap left by a
// week the job did not run.
export async function snapshotChokepointTransits(): Promise<ChokepointSnapshotResult> {
  const db = getDb();
  // "Is the window actually covered?", not "is the table empty?" and not
  // "how old is the oldest row?". Both weaker questions were tried and
  // both were wrong: the first run wrote one truncated page, so the table
  // was neither empty nor short at the front — it had its oldest rows and
  // its newest rows with a months-wide hole between them, which only a
  // count of the days actually present can see. Counting days makes a
  // gappy table repair itself on the next run, whatever left it gappy.
  const [existing] = await db
    .select({ days: sql<number>`count(distinct ${chokepointTransitHistory.snapshotDate})::int` })
    .from(chokepointTransitHistory)
    .where(sql`${chokepointTransitHistory.snapshotDate} >= ${isoDaysAgo(BACKFILL_DAYS)}`);
  const isBackfill = (existing?.days ?? 0) < BACKFILL_DAYS * COVERAGE_TARGET;
  const since = isoDaysAgo(isBackfill ? BACKFILL_DAYS : 45);

  const rows = await fetchChokepointTransitHistory(since);
  if (rows.length === 0) {
    return { fetched: 0, written: 0, pruned: 0, backfilled: isBackfill };
  }

  const cutoff = isoDaysAgo(CHOKEPOINT_RETENTION_DAYS);
  const values = rows
    .filter((r) => r.date >= cutoff)
    .map((r) => ({
      chokepoint: r.name,
      snapshotDate: r.date,
      totalVessels: r.totalVessels,
      cargoVessels: r.cargoVessels,
      tankerVessels: r.tankerVessels,
    }));

  // Chunked: a backfill is ~11k rows and the neon-http driver sends one
  // statement per call, so a single INSERT with that many VALUES tuples
  // would be a multi-megabyte statement.
  const CHUNK = 500;
  const cols = getTableColumns(chokepointTransitHistory);
  let written = 0;
  for (let i = 0; i < values.length; i += CHUNK) {
    const chunk = values.slice(i, i + CHUNK);
    await db
      .insert(chokepointTransitHistory)
      .values(chunk)
      .onConflictDoUpdate({
        target: [cols.chokepoint, cols.snapshotDate],
        set: {
          totalVessels: sql`excluded.total_vessels`,
          cargoVessels: sql`excluded.cargo_vessels`,
          tankerVessels: sql`excluded.tanker_vessels`,
        },
      });
    written += chunk.length;
  }

  const pruned = await db
    .delete(chokepointTransitHistory)
    .where(sql`${chokepointTransitHistory.snapshotDate} < ${cutoff}`);

  return {
    fetched: rows.length,
    written,
    pruned: (pruned as unknown as { rowCount?: number }).rowCount ?? 0,
    backfilled: isBackfill,
  };
}

export interface ChokepointAnomalyOutcome {
  country: string;
  chokepoint: string;
  outcome: AnomalyOutcome;
}

// One outcome per (chokepoint, littoral country) pair. A chokepoint with
// two shores produces the same finding for both, which is correct: a
// Kerch Strait disruption is a real signal for Russia and for Ukraine,
// and a reader looking at either country should see it.
export async function getChokepointAnomalyOutcomes(): Promise<ChokepointAnomalyOutcome[]> {
  const db = getDb();
  const since = isoDaysAgo(ANOMALY_LOOKBACK_DAYS);
  const rows = await db
    .select({
      chokepoint: chokepointTransitHistory.chokepoint,
      snapshotDate: chokepointTransitHistory.snapshotDate,
      totalVessels: chokepointTransitHistory.totalVessels,
    })
    .from(chokepointTransitHistory)
    .where(sql`${chokepointTransitHistory.snapshotDate} >= ${since}`)
    .orderBy(desc(chokepointTransitHistory.snapshotDate));

  const byPoint = new Map<string, { value: number; at: Date }[]>();
  for (const r of rows) {
    const list = byPoint.get(r.chokepoint) ?? [];
    // Midday UTC, so a date-only value can't land on the wrong side of a
    // timezone boundary in the staleness check.
    list.push({ value: r.totalVessels, at: new Date(`${r.snapshotDate}T12:00:00Z`) });
    byPoint.set(r.chokepoint, list);
  }

  const outcomes: ChokepointAnomalyOutcome[] = [];
  for (const [chokepoint, samples] of byPoint) {
    const countries = CHOKEPOINT_COUNTRIES[chokepoint];
    // An unmapped chokepoint is a new one upstream, not an error: skip it
    // rather than inventing an attribution, and it shows up as a gap the
    // next time anyone reads this table.
    if (!countries || countries.length === 0) continue;

    const outcome = detectAnomaly(samples, {
      ...DEFAULT_BASELINE_CONFIG,
      lookbackDays: ANOMALY_LOOKBACK_DAYS,
      maxLatestAgeMs: MAX_LATEST_AGE_MS,
      // Both directions matter here, and a drop matters most: a fall in
      // transits is a blockage, a closure, or shipping choosing to route
      // around a threat. Only the commercial-aircraft signal shares this.
      allowNegativeJump: true,
      // Transit counts span three orders of magnitude across these 28
      // points (Magellan single digits, Malacca low hundreds). A flat
      // absolute-jump floor would either mute the small ones or spam
      // from the big ones, so the floor is deliberately low and the
      // baseline-mean floor below does the work of muting series that are
      // too quiet for a z-score to mean anything.
      minAbsoluteJump: 3,
      minBaselineMean: 3,
    });
    for (const country of countries) {
      outcomes.push({ country, chokepoint, outcome });
    }
  }
  return outcomes;
}
