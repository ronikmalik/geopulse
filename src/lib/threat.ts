// The Threat Level + Momentum model. Deliberately NOT a single 0-100
// "country risk score" — that reads as falsely precise. Instead every
// country (and every pillar within it) carries two separate measures:
//
//   Threat Level  1-5   categorical, "how bad is it right now"
//   Momentum      0-100 + direction, "how fast is it changing"
//
// See docs/ROADMAP.md section 3 for the full design rationale.

export type ThreatLevel = 1 | 2 | 3 | 4 | 5;

export const THREAT_LEVELS: ThreatLevel[] = [1, 2, 3, 4, 5];

export const THREAT_LABELS: Record<ThreatLevel, string> = {
  1: "Low",
  2: "Guarded",
  3: "Elevated",
  4: "High",
  5: "Critical",
};

export const THREAT_DESCRIPTIONS: Record<ThreatLevel, string> = {
  1: "Normal conditions; no significant active threats.",
  2: "Elevated conditions or localized disruptions worth monitoring.",
  3: "Material active threats with meaningful national or regional implications.",
  4: "Severe instability or disruption with significant population, infrastructure, or economic exposure.",
  5: "Extreme conditions such as major war, state instability, catastrophic disaster, or systemic infrastructure failure.",
};

// Muted-neutral to alarm red, tracking the app's existing red-alert palette.
export const THREAT_COLORS: Record<ThreatLevel, string> = {
  1: "#6b7280",
  2: "#eab308",
  3: "#f97316",
  4: "#ef4444",
  5: "#b91c1c",
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
// a Threat Level. Heuristic, tuned for a feed that typically sees a
// handful of severity 2-3 items/day per pillar in calm conditions and
// severity 4-5 spikes during an active crisis — expect to recalibrate
// against real usage data rather than treat these as fixed truth.
const THREAT_LEVEL_THRESHOLDS: [min: number, level: ThreatLevel][] = [
  [35, 5],
  [15, 4],
  [6, 3],
  [2, 2],
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

// Escalation model: overall Threat Level is the max of the active pillar
// levels, not an average — a catastrophic single-pillar event must not be
// diluted by calm conditions elsewhere. When two or more pillars are
// independently Elevated (3) or above, that's reinforcing multi-pillar
// deterioration, which reads as more dangerous than an isolated spike, so
// it adds one extra level (capped at 5).
export function escalateThreatLevel(pillarLevels: ThreatLevel[]): ThreatLevel {
  if (pillarLevels.length === 0) return 1;
  const max = Math.max(...pillarLevels) as ThreatLevel;
  const elevatedOrAboveCount = pillarLevels.filter((l) => l >= 3).length;
  const bump = elevatedOrAboveCount >= 2 ? 1 : 0;
  return Math.min(5, max + bump) as ThreatLevel;
}
