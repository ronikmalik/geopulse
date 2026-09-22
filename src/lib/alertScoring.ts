// The alert engine's decision function (2026-09-22). Pure: numbers in,
// tier out, no database and no network, so the whole thing is testable
// and a fired alert can be recomputed from its own stored inputs months
// later and land on the same tier.
//
// Nothing here consults a language model. A tier is a threshold over a
// weighted sum of six stored measurements, plus hard gates on the top two
// tiers. That is a deliberate constraint, not a limitation waiting to be
// lifted: an alert that a model decided was important cannot be audited,
// tuned, or defended to somebody asking why they were woken up.
//
// The tiers mean what they say:
//   FLASH    - a country's assessed risk level just rose into serious
//              territory, with independent corroboration. Rare by
//              construction (see the gates), not by luck.
//   PRIORITY - a real change worth reading today.
//   WATCH    - worth knowing, no action implied.
//   ROUTINE  - logged, not pushed.
// Below ROUTINE nothing is written at all; most countries on most runs
// produce nothing, which is the point.

export type AlertTier = "FLASH" | "PRIORITY" | "WATCH" | "ROUTINE";

export const ALERT_TIERS: AlertTier[] = ["FLASH", "PRIORITY", "WATCH", "ROUTINE"];

// Higher index = more severe, for comparing two tiers (escalation checks).
export function tierRank(tier: AlertTier): number {
  return ALERT_TIERS.length - ALERT_TIERS.indexOf(tier);
}

export interface AlertInputs {
  // Assessed Pulse Level now and at the previous evaluation (1-4).
  level: number;
  previousLevel: number;
  // Momentum now and at the previous evaluation (0-100).
  momentum: number;
  previousMomentum: number;
  // Highest severity among the country's driving events in the window (1-5).
  maxSeverity: number;
  // Distinct source FAMILIES behind the driving event — "reuters" and
  // "telegram:presstv" are two, two Reuters wires are one. Corroboration
  // is about independence, not article count.
  sourceFamilies: number;
  // Distinct anomaly signals firing for this country in the latest scan
  // (aircraft, GPS jamming, chokepoint transits, news volume, ...), now
  // and at the previous evaluation.
  anomalySignals: number;
  previousAnomalySignals: number;
  // Distinct pillars with activity in the last 24h. Cross-domain
  // agreement is the strongest corroboration this system can offer.
  pillarsActive: number;
}

export interface AlertScoreComponent {
  name: string;
  points: number;
  detail: string;
}

export interface AlertAssessment {
  tier: AlertTier | null;
  score: number;
  components: AlertScoreComponent[];
  // Which gate blocked a higher tier, when one did. Stored so a reader
  // can see why something is PRIORITY and not FLASH.
  gateNotes: string[];
}

// Point values. These are judgment, and they are written down here in one
// place precisely so they can be argued with rather than reverse-
// engineered out of behaviour.
const POINTS = {
  levelRise1: 30,
  levelRise2: 55,
  levelRise3Plus: 70,
  atLevel4: 15,
  atLevel3: 8,
  momentumHigh: 15, // >= 80
  momentumElevated: 8, // >= 60
  momentumSurge: 12, // rose >= 25 since last look
  severity5: 15,
  severity4: 8,
  corroborationStrong: 12, // >= 3 independent families
  corroborationPresent: 6, // 2 families
  perAnomalySignal: 6,
  anomalyCap: 18,
  crossDomainStrong: 10, // >= 3 pillars active
  crossDomainPresent: 5, // 2 pillars
} as const;

const THRESHOLDS: Record<AlertTier, number> = {
  FLASH: 85,
  PRIORITY: 55,
  WATCH: 35,
  ROUTINE: 20,
};

// Gates for the top two tiers. A score alone cannot reach FLASH: the
// country's assessed level must actually have RISEN, must have risen to
// somewhere serious, and at least two independent source families must
// stand behind it. Without these, a single hysterical outlet in a country
// that was already tense could total up to 85 on volume alone.
const FLASH_MIN_LEVEL = 3;
const FLASH_MIN_SOURCE_FAMILIES = 2;
const PRIORITY_MIN_SOURCE_FAMILIES = 2;

// The rule that decides whether there is anything to say at all.
//
// An alert means something CHANGED. A country that has been at level 4
// for three months is not news, however high it scores — and scoring is
// exactly where a standing war zone beats a fresh coup, because severity
// and volume are both high every single day. A dry run against live data
// made the point: with nothing changing anywhere, 14 countries still
// cleared a tier threshold on their standing badness alone.
//
// So no tier is reachable without movement in one of the three state
// variables this engine tracks between runs. This is also what keeps the
// table small enough to belong on a 500 MB database.
export function hasChanged(input: AlertInputs): boolean {
  return (
    input.level - input.previousLevel >= 1 ||
    input.momentum - input.previousMomentum >= 25 ||
    input.anomalySignals - input.previousAnomalySignals >= 1
  );
}

export function assessAlert(input: AlertInputs): AlertAssessment {
  const components: AlertScoreComponent[] = [];
  const add = (name: string, points: number, detail: string) => {
    if (points !== 0) components.push({ name, points, detail });
  };

  const levelRise = input.level - input.previousLevel;
  if (levelRise >= 3) add("level-rise", POINTS.levelRise3Plus, `level ${input.previousLevel} to ${input.level}`);
  else if (levelRise === 2) add("level-rise", POINTS.levelRise2, `level ${input.previousLevel} to ${input.level}`);
  else if (levelRise === 1) add("level-rise", POINTS.levelRise1, `level ${input.previousLevel} to ${input.level}`);

  if (input.level >= 4) add("standing-level", POINTS.atLevel4, "at level 4");
  else if (input.level >= 3) add("standing-level", POINTS.atLevel3, "at level 3");

  if (input.momentum >= 80) add("momentum", POINTS.momentumHigh, `momentum ${input.momentum}`);
  else if (input.momentum >= 60) add("momentum", POINTS.momentumElevated, `momentum ${input.momentum}`);

  const momentumRise = input.momentum - input.previousMomentum;
  if (momentumRise >= 25) add("momentum-surge", POINTS.momentumSurge, `momentum +${momentumRise}`);

  if (input.maxSeverity >= 5) add("severity", POINTS.severity5, "a severity-5 event");
  else if (input.maxSeverity >= 4) add("severity", POINTS.severity4, "a severity-4 event");

  if (input.sourceFamilies >= 3)
    add("corroboration", POINTS.corroborationStrong, `${input.sourceFamilies} independent source families`);
  else if (input.sourceFamilies === 2) add("corroboration", POINTS.corroborationPresent, "2 independent source families");

  if (input.anomalySignals > 0) {
    const pts = Math.min(input.anomalySignals * POINTS.perAnomalySignal, POINTS.anomalyCap);
    add("anomaly-corroboration", pts, `${input.anomalySignals} unusual signal${input.anomalySignals === 1 ? "" : "s"}`);
  }

  if (input.pillarsActive >= 3) add("cross-domain", POINTS.crossDomainStrong, `${input.pillarsActive} risk domains active`);
  else if (input.pillarsActive === 2) add("cross-domain", POINTS.crossDomainPresent, "2 risk domains active");

  const score = components.reduce((sum, c) => sum + c.points, 0);
  const gateNotes: string[] = [];

  if (!hasChanged(input)) {
    return {
      tier: null,
      score,
      components,
      gateNotes: ["no alert: nothing changed since the last evaluation"],
    };
  }

  let tier: AlertTier | null = null;
  if (score >= THRESHOLDS.FLASH) {
    const reasons: string[] = [];
    if (levelRise < 1) reasons.push("risk level did not rise");
    if (input.level < FLASH_MIN_LEVEL) reasons.push(`level ${input.level} is below ${FLASH_MIN_LEVEL}`);
    if (input.sourceFamilies < FLASH_MIN_SOURCE_FAMILIES)
      reasons.push(`only ${input.sourceFamilies} source family`);
    if (reasons.length === 0) tier = "FLASH";
    else gateNotes.push(`held below FLASH: ${reasons.join("; ")}`);
  }
  if (!tier && score >= THRESHOLDS.PRIORITY) {
    // PRIORITY additionally needs more than one voice. A single outlet's
    // account of a developing situation is a WATCH until somebody
    // independent says the same thing.
    if (input.sourceFamilies < PRIORITY_MIN_SOURCE_FAMILIES)
      gateNotes.push(`held below PRIORITY: only ${input.sourceFamilies} source family`);
    else tier = "PRIORITY";
  }
  if (!tier && score >= THRESHOLDS.WATCH) tier = "WATCH";
  if (!tier && score >= THRESHOLDS.ROUTINE) tier = "ROUTINE";

  return { tier, score, components, gateNotes };
}

// Repeat suppression, adapted from the tiering idea in Crucix's alert
// layer (AGPL — the concept, written from scratch, no code): the first
// alert for a country goes out immediately and each further one inside
// the decay window waits longer, so a grinding situation does not
// re-announce itself every half hour.
//
// Escalation always escapes suppression. Being told a level-2 country is
// now level-4 matters more than the fact that it was mentioned an hour
// ago, and a cooldown that swallowed that would be worse than no
// cooldown at all.
const COOLDOWN_HOURS = [0, 6, 12, 24];

export function cooldownHoursFor(priorAlertsInWindow: number): number {
  return COOLDOWN_HOURS[Math.min(priorAlertsInWindow, COOLDOWN_HOURS.length - 1)];
}

export interface SuppressionDecision {
  suppressed: boolean;
  reason: string | null;
}

export function shouldSuppress(
  tier: AlertTier,
  lastTier: AlertTier | null,
  hoursSinceLastAlert: number | null,
  priorAlertsInWindow: number,
): SuppressionDecision {
  if (lastTier === null || hoursSinceLastAlert === null) return { suppressed: false, reason: null };
  if (tierRank(tier) > tierRank(lastTier)) return { suppressed: false, reason: null };
  const required = cooldownHoursFor(priorAlertsInWindow);
  if (hoursSinceLastAlert >= required) return { suppressed: false, reason: null };
  return {
    suppressed: true,
    reason: `${tier} within ${hoursSinceLastAlert.toFixed(1)}h of a ${lastTier} (cooldown ${required}h)`,
  };
}

export { THRESHOLDS as ALERT_THRESHOLDS, POINTS as ALERT_POINTS };
