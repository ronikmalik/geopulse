// The Pulse Level + Momentum model. Deliberately NOT a single 0-100
// "country risk score" — that reads as falsely precise, and this project
// isn't in the business of judging a country's risk anyway. What it
// actually measures is the magnitude of live, real-world signal a country
// is generating right now: every country (and every pillar within it)
// carries two separate measures:
//
//   Pulse Level  1-4   categorical, "how much is happening right now"
//   Momentum     0-100 + direction, "how fast is it changing"
//
// The internal name (ThreatLevel, threatLabel, etc.) is unchanged
// throughout the codebase — this is a user-facing relabeling, not a
// different model — see docs/ROADMAP.md section 3 for the full design
// rationale.

export type ThreatLevel = 1 | 2 | 3 | 4;

export const THREAT_LEVELS: ThreatLevel[] = [1, 2, 3, 4];

export const THREAT_LABELS: Record<ThreatLevel, string> = {
  1: "Low",
  2: "Medium",
  3: "High",
  4: "Extreme",
};

// Extreme is deliberately reserved for the handful of situations that
// actually warrant it — an active war (Ukraine), a major regional conflict
// (Iran and its surrounding theater), a catastrophic natural disaster, or
// large-scale geopolitical unrest — not just "a busy news day" for an
// otherwise calm country. See THREAT_LEVEL_THRESHOLDS below for where that
// bar is actually set.
export const THREAT_DESCRIPTIONS: Record<ThreatLevel, string> = {
  1: "Normal conditions — no significant active signal.",
  2: "Localized or moderate disruption worth monitoring.",
  3: "Sustained, high-magnitude signal with real regional impact.",
  4: "Extreme, sustained signal — major war, catastrophic disaster, or large-scale unrest.",
};

// Muted-neutral to alarm red, tracking the app's existing red-alert palette.
export const THREAT_COLORS: Record<ThreatLevel, string> = {
  1: "#6b7280",
  2: "#eab308",
  3: "#ef4444",
  4: "#b91c1c",
};

export type MomentumDirection = -1 | 0 | 1;

export interface Momentum {
  magnitude: number; // 0-100
  direction: MomentumDirection;
}

export function momentumArrow(direction: MomentumDirection): string {
  return direction > 0 ? "↑" : direction < 0 ? "↓" : "→";
}

export function momentumBucketLabel(magnitude: number): string {
  if (magnitude <= 10) return "Stable";
  if (magnitude <= 30) return "Slight movement";
  if (magnitude <= 50) return "Moderate movement";
  if (magnitude <= 70) return "Strong movement";
  if (magnitude <= 85) return "Very strong movement";
  return "Extreme movement";
}

// Decayed-severity-sum thresholds mapping a pillar's weighted event load to
// a Pulse Level. Heuristic, tuned for a feed that typically sees a handful
// of severity 2-3 items/day per pillar in calm conditions and severity 4-5
// spikes during an active crisis — expect to recalibrate against real
// usage data rather than treat these as fixed truth. The top bucket (30+)
// is set deliberately high, well above what a single bad news day
// produces, so "Extreme" stays rare — Ukraine, an active Iran-region
// conflict, a catastrophic disaster, not routine escalation language.
const THREAT_LEVEL_THRESHOLDS: [min: number, level: ThreatLevel][] = [
  [30, 4],
  [12, 3],
  [3, 2],
];

export function weightToThreatLevel(weight: number): ThreatLevel {
  for (const [min, level] of THREAT_LEVEL_THRESHOLDS) {
    if (weight >= min) return level;
  }
  return 1;
}

// Compares a recent window's raw severity sum to the prior window of equal
// length. `prior` is floored at 1 so going from zero activity to any
// activity reads as a strong up-move instead of a divide-by-near-zero
// spike straight to the ceiling.
export function computeMomentum(recent: number, prior: number): Momentum {
  if (recent === 0 && prior === 0) return { magnitude: 0, direction: 0 };
  const priorFloor = Math.max(prior, 1);
  const pctChange = (recent - prior) / priorFloor;
  // Saturating curve: magnitude reflects how far into "extreme" territory
  // the change sits, not the raw (unbounded) percentage change.
  const magnitude = Math.round(100 * (1 - 1 / (1 + Math.abs(pctChange))));
  const direction: MomentumDirection =
    recent === prior ? 0 : recent > prior ? 1 : -1;
  return { magnitude: Math.min(100, magnitude), direction };
}

// Blends a short (24h) and long (7d) horizon into one displayed momentum,
// weighting the faster horizon more heavily — momentum should track
// current velocity, not just a slow-moving trend, per the blueprint's
// multi-horizon requirement (1h/24h/7d/30d; this build implements 24h/7d).
export function blendMomentum(short: Momentum, long: Momentum): Momentum {
  const magnitude = Math.round(short.magnitude * 0.6 + long.magnitude * 0.4);
  const direction: MomentumDirection =
    short.direction !== 0 ? short.direction : long.direction;
  return { magnitude, direction };
}

// Escalation model: overall Pulse Level is the max of the active pillar
// levels, not an average — a catastrophic single-pillar event must not be
// diluted by calm conditions elsewhere. When two or more pillars are
// independently High (3) or above, that's reinforcing multi-pillar
// activity, which reads as more significant than an isolated spike, so it
// adds one extra level (capped at 4).
export function escalateThreatLevel(pillarLevels: ThreatLevel[]): ThreatLevel {
  if (pillarLevels.length === 0) return 1;
  const max = Math.max(...pillarLevels) as ThreatLevel;
  const highOrAboveCount = pillarLevels.filter((l) => l >= 3).length;
  const bump = highOrAboveCount >= 2 ? 1 : 0;
  return Math.min(4, max + bump) as ThreatLevel;
}
