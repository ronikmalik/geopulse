import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { countryStateHistory } from "@/db/schema";
import { getCountryThreatSummaries } from "@/lib/risk";

// Snapshots every country's current Pulse Level/momentum into
// country_state_history — a daily time series independent of the events
// table's 30-day scoring lookback, so "how has this country trended over
// the last 3 months" becomes a real query instead of something only the
// live score can answer. Called by /api/admin/snapshot, on the daily cron
// defined in vercel.json.
export async function snapshotCountryStates(): Promise<{ inserted: number }> {
  const db = getDb();
  const summaries = await getCountryThreatSummaries();

  if (summaries.length === 0) return { inserted: 0 };

  const rows = summaries.map((s) => ({
    country: s.country,
    score: s.score,
    threatLevel: s.threatLevel,
    momentum: s.momentum,
    momentumDirection: s.momentumDirection,
    eventCount: s.eventCount,
  }));

  const result = await db
    .insert(countryStateHistory)
    .values(rows)
    .returning({ id: countryStateHistory.id });

  return { inserted: result.length };
}

// One country's trend over time — the trailing baseline this is all for.
// Not wired into the UI yet (see docs/ROADMAP.md); this is the query that
// a future "vs. this country's own 90-day average" comparison, or a
// sparkline on the Pulse tab, would read from.
export async function getCountryHistory(
  country: string,
  days = 90,
): Promise<
  { snapshotAt: string; score: number; threatLevel: number; momentum: number }[]
> {
  const db = getDb();
  const iso2 = country.toUpperCase();
  const rows = await db.query.countryStateHistory.findMany({
    where: (h, { and, eq, gt }) =>
      and(
        eq(h.country, iso2),
        gt(h.snapshotAt, sql`now() - interval '${sql.raw(String(days))} days'`),
      ),
    orderBy: (h, { asc }) => asc(h.snapshotAt),
  });

  return rows.map((r) => ({
    snapshotAt: r.snapshotAt.toISOString(),
    score: r.score,
    threatLevel: r.threatLevel,
    momentum: r.momentum,
  }));
}
