import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { countryStateHistory } from "@/db/schema";
import { getCountryThreatSummaries } from "@/lib/risk";
import { THREAT_LABELS, type ThreatLevel } from "@/lib/threat";

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
  }));

  const result = await db
    .insert(countryStateHistory)
    .values(rows)
    .returning({ id: countryStateHistory.id });

  return { inserted: result.length };
}

export interface HistorySnapshot {
  snapshotAt: string;
  score: number;
  threatLevel: ThreatLevel;
  momentum: number;
}

// One country's trend over time — the trailing baseline the whole
// snapshot system exists to eventually enable.
export async function getCountryHistory(
  country: string,
  days = 365,
): Promise<HistorySnapshot[]> {
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
    threatLevel: r.threatLevel as ThreatLevel,
    momentum: r.momentum,
  }));
}

export interface HistorySummary {
  country: string;
  daysTracked: number;
  current: { threatLevel: ThreatLevel; threatLabel: string; score: number; momentum: number } | null;
  levelDayCounts: Partial<Record<ThreatLevel, number>>;
  peak: { threatLevel: ThreatLevel; threatLabel: string; score: number; snapshotAt: string } | null;
  trend: "rising" | "falling" | "steady" | "insufficient-data";
  text: string;
}

// A deterministic, entirely numbers-derived summary — no free-text
// generation, nothing invented. "Ask for a summary of the trend" gets
// answered by actually computing one from the stored snapshots, the same
// discipline as the rest of this app's classification (real data only,
// 0 is a valid answer, and "not enough history yet" is said outright
// rather than guessed at).
export function summarizeHistory(country: string, history: HistorySnapshot[]): HistorySummary {
  const iso2 = country.toUpperCase();
  if (history.length === 0) {
    return {
      country: iso2,
      daysTracked: 0,
      current: null,
      levelDayCounts: {},
      peak: null,
      trend: "insufficient-data",
      text: `No history recorded yet for this country — snapshots started ${new Date().toISOString().slice(0, 10)} and accumulate once a day.`,
    };
  }

  const levelDayCounts: Partial<Record<ThreatLevel, number>> = {};
  let peak = history[0];
  for (const h of history) {
    levelDayCounts[h.threatLevel] = (levelDayCounts[h.threatLevel] ?? 0) + 1;
    if (h.score > peak.score) peak = h;
  }

  const latest = history[history.length - 1];

  // Trend needs at least a few points on each side to say anything — with
  // 1-2 snapshots total there's no "recent vs. earlier" to compare.
  let trend: HistorySummary["trend"] = "insufficient-data";
  if (history.length >= 6) {
    const half = Math.floor(history.length / 2);
    const earlyAvg = history.slice(0, half).reduce((s, h) => s + h.score, 0) / half;
    const recentAvg =
      history.slice(-half).reduce((s, h) => s + h.score, 0) / half;
    const delta = recentAvg - earlyAvg;
    const threshold = Math.max(1, earlyAvg * 0.15);
    trend = delta > threshold ? "rising" : delta < -threshold ? "falling" : "steady";
  }

  const levelBreakdown = Object.entries(levelDayCounts)
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([level, count]) => `${count} ${THREAT_LABELS[Number(level) as ThreatLevel]}`)
    .join(", ");

  const trendText =
    trend === "insufficient-data"
      ? "Not enough history yet to call a trend (needs at least 6 daily snapshots)."
      : `Trend over this window: ${trend}.`;

  const text =
    `Tracking ${iso2} for ${history.length} day${history.length === 1 ? "" : "s"}. ` +
    `Currently ${THREAT_LABELS[latest.threatLevel]} (score ${latest.score.toFixed(1)}, momentum ${latest.momentum}). ` +
    `Breakdown: ${levelBreakdown}. ` +
    `Peak: ${THREAT_LABELS[peak.threatLevel]} on ${peak.snapshotAt.slice(0, 10)}. ` +
    trendText;

  return {
    country: iso2,
    daysTracked: history.length,
    current: {
      threatLevel: latest.threatLevel,
      threatLabel: THREAT_LABELS[latest.threatLevel],
      score: latest.score,
      momentum: latest.momentum,
    },
    levelDayCounts,
    peak: {
      threatLevel: peak.threatLevel,
      threatLabel: THREAT_LABELS[peak.threatLevel],
      score: peak.score,
      snapshotAt: peak.snapshotAt,
    },
    trend,
    text,
  };
}
