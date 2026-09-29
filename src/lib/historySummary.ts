import { THREAT_LABELS, type ThreatLevel } from "@/lib/threat";
import { SCORING_VERSION } from "@/lib/scoringMethod";

// Pure — no db access — so the Trends tab can run it in the browser with
// the live score added (2026-09-29). history.ts reads the snapshots.

export interface HistorySnapshot {
  snapshotAt: string;
  score: number;
  threatLevel: ThreatLevel;
  momentum: number;
  // Set only on the point withLivePoint appends; stored snapshots never carry it.
  live?: boolean;
}

// The live score as the newest point (2026-09-29). Snapshots are taken once
// a day at 18:00 UTC, so the newest one can be most of a day old: Estonia
// read 0.0 Low for six straight days while its live score was 26.3 High.
// Live and snapshot scores come from the same getCountryThreatSummaries,
// so they share a scale. The live point stands in for today's snapshot
// rather than sitting beside it, keeping one point per UTC day.
export function withLivePoint(history: HistorySnapshot[], live: HistorySnapshot | null): HistorySnapshot[] {
  if (!live) return history;
  const today = live.snapshotAt.slice(0, 10);
  return [...history.filter((h) => h.snapshotAt.slice(0, 10) !== today), { ...live, live: true }];
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
// rather than guessed at). A trailing live point (withLivePoint) counts as
// today and is named as such in the text.
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
      text: `No snapshots recorded yet for this country under scoring method v${SCORING_VERSION}. One is taken each day.`,
    };
  }

  const levelDayCounts: Partial<Record<ThreatLevel, number>> = {};
  let peak = history[0];
  for (const h of history) {
    levelDayCounts[h.threatLevel] = (levelDayCounts[h.threatLevel] ?? 0) + 1;
    if (h.score > peak.score) peak = h;
  }

  const latest = history[history.length - 1];
  const snapshots = history.filter((h) => !h.live).length;

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
      ? "Not enough history yet to call a trend (needs at least 6 days)."
      : `Trend over this window: ${trend}.`;

  const text =
    `${snapshots} daily snapshot${snapshots === 1 ? "" : "s"} under scoring method v${SCORING_VERSION}` +
    `${latest.live ? ", then today's live score" : ""}. ` +
    `${latest.live ? "Now" : "Currently"} ${THREAT_LABELS[latest.threatLevel]} (score ${latest.score.toFixed(1)}, momentum ${latest.momentum}). ` +
    `Breakdown: ${levelBreakdown}. ` +
    `Peak: ${THREAT_LABELS[peak.threatLevel]} ${peak.live ? "now" : `on ${peak.snapshotAt.slice(0, 10)}`}. ` +
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
