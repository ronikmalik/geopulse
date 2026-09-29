import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { countryStateHistory } from "@/db/schema";
import { getCountryThreatSummaries } from "@/lib/risk";
import type { ThreatLevel } from "@/lib/threat";
import { SCORING_VERSION } from "@/lib/scoringMethod";
import type { HistorySnapshot } from "@/lib/historySummary";

// Snapshots every country's current Pulse Level/momentum into
// country_state_history — a daily time series independent of the events
// table's 30-day scoring lookback, so "how has this country trended over
// the last 3 months" becomes a real query instead of something only the
// live score can answer. Called by /api/admin/snapshot, on the daily cron
// defined in vercel.ts.
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
    scoringVersion: SCORING_VERSION,
  }));

  const result = await db
    .insert(countryStateHistory)
    .values(rows)
    .returning({ id: countryStateHistory.id });

  return { inserted: result.length };
}

export interface CountryHistory {
  history: HistorySnapshot[];
  // Days in the window that were scored under an earlier method and are
  // therefore left out of `history` (see getCountryHistory).
  earlierMethodDays: number;
}

// One country's trend over time — the trailing baseline the whole
// snapshot system exists to eventually enable.
//
// Only snapshots scored by the current method (2026-09-28). The score's
// scale changed with each SCORING_VERSION (Ukraine reads ~21 under v1 and
// ~1,280 under v2 for similar weeks), so a chart, peak or rising/falling
// call across versions measured the method change, not the country.
// One snapshot per UTC day, the latest: a re-run snapshot job left some
// days with two rows seconds apart.
export async function getCountryHistory(country: string, days = 365): Promise<CountryHistory> {
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

  const byDay = new Map<string, HistorySnapshot>();
  const earlierDays = new Set<string>();
  for (const r of rows) {
    const day = r.snapshotAt.toISOString().slice(0, 10);
    if (r.scoringVersion !== SCORING_VERSION) {
      earlierDays.add(day);
      continue;
    }
    byDay.set(day, {
      snapshotAt: r.snapshotAt.toISOString(),
      score: r.score,
      threatLevel: r.threatLevel as ThreatLevel,
      momentum: r.momentum,
    });
  }
  const history = [...byDay.values()];
  for (const h of history) earlierDays.delete(h.snapshotAt.slice(0, 10));
  return { history, earlierMethodDays: earlierDays.size };
}
