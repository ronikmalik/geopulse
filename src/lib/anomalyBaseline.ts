// Shared statistical core for every anomaly signal in this app — extracted
// 2026-09-09 from flightBaseline.ts's original getAircraftAnomalies, which
// was the first (and until now, only) instance of this exact pattern: a
// plain z-score against a country's own trailing history, not ML, not a
// trained model. See docs/ROADMAP.md's "no falsely precise single score"
// principle — this deliberately stays simple statistics, not a fabricated
// composite. flightBaseline.ts itself now calls this module instead of
// duplicating the math, so there is exactly one implementation of the
// algorithm, not several that could quietly drift apart.
//
// Deliberately NOT median/MAD (a more "robust" statistic in textbook
// terms): at the sample sizes this app actually has (14-30 daily
// snapshots), MAD has its own well-known failure mode — a baseline with
// several tied/zero values (common for quiet countries) collapses MAD to
// near zero, which blows up the resulting score just as badly as a plain
// stddev would on the same data, but with less production validation
// behind it. flightBaseline.ts's mean/stddev approach is the one thing in
// this codebase already proven correct against real traffic, so every new
// signal inherits that exact method rather than a theoretically-nicer one
// with no track record here.
export interface AnomalySample {
  value: number;
  at: Date;
}

export interface BaselineConfig {
  // How far back a sample can be and still count toward the baseline.
  lookbackDays: number;
  // Fewer baseline samples than this and a single unusual day would swing
  // the baseline itself, not just flag against it — matches
  // flightBaseline.ts's original MIN_BASELINE_SAMPLES=14.
  minBaselineSamples: number;
  // Also require an absolute jump, not just a statistical one — a series
  // whose baseline is "0 or 1 most days" can have a technically enormous
  // z-score from a single-unit increase, which isn't a meaningful surge.
  minAbsoluteJump: number;
  zScoreThreshold: number;
  // Guards a stale snapshot from being read as "today's value" if this
  // signal's own cron never fired — matches flightBaseline.ts's original
  // MAX_LATEST_AGE_MS, but per-signal since not every signal shares one
  // cron schedule (see anomalyScan.ts).
  maxLatestAgeMs: number;
  // NEW (2026-09-09, event-volume-per-category signal): skip series whose
  // baseline mean sits below this floor. Many country×category cells are
  // mostly zeros (e.g. humanitarian events in a quiet country), and a
  // 0→3 jump on a near-zero baseline blows up the z-score exactly the way
  // the MAD discussion above describes — this floor is the plain-stddev
  // equivalent guard, applied only where a signal actually needs it.
  minBaselineMean?: number;
  // NEW (2026-09-09, commercial-flight-count signal): a large DROP
  // matters for this signal (an airspace closure), not just a rise, unlike
  // every other signal here where only an increase is meaningful. Off by
  // default — only the one signal that needs it turns it on.
  allowNegativeJump?: boolean;
}

export interface BaselineResult {
  observedValue: number;
  baselineMean: number;
  baselineStdDev: number;
  sampleSize: number;
  jump: number;
  zScore: number;
}

// Discriminated outcome, not a plain null — a 2026-09-09 design-review
// finding: this app's crons have a documented history of silently not
// firing (.github/workflows/ingest.yml's own comment: didn't fire for
// over a week once). If "stale data" and "checked, wasn't anomalous" both
// collapsed to the same null, a broken cron would look identical to a
// quiet day everywhere anomalyScan.ts reports results — indistinguishable
// and undebuggable from the outside. Every caller that only wants the
// simple "what's anomalous" list still gets one (see each signal module's
// exported wrapper), but the diagnostic detail is preserved for
// anomalyScan.ts's own reporting.
export type AnomalyOutcome =
  | { status: "anomaly"; data: BaselineResult }
  | { status: "insufficient-baseline"; sampleSize: number; needed: number }
  | { status: "stale"; ageMs: number; maxAgeMs: number }
  | { status: "normal" }; // checked against a real baseline, genuinely not unusual

// `samples` must be sorted newest-first — every caller already queries its
// own table with `orderBy(desc(...))` for its own reasons (freshness
// checks, display order), so sorting again here would be redundant work
// for no benefit.
export function detectAnomaly(
  samples: AnomalySample[],
  config: BaselineConfig,
): AnomalyOutcome {
  const [latest, ...baseline] = samples;
  if (!latest || baseline.length < config.minBaselineSamples) {
    return { status: "insufficient-baseline", sampleSize: baseline.length, needed: config.minBaselineSamples };
  }
  const ageMs = Date.now() - latest.at.getTime();
  if (ageMs > config.maxLatestAgeMs) {
    return { status: "stale", ageMs, maxAgeMs: config.maxLatestAgeMs };
  }

  const mean = baseline.reduce((sum, b) => sum + b.value, 0) / baseline.length;
  if (config.minBaselineMean !== undefined && mean < config.minBaselineMean) {
    return { status: "normal" };
  }

  const variance =
    baseline.reduce((sum, b) => sum + (b.value - mean) ** 2, 0) / (baseline.length - 1);
  const stdDev = Math.sqrt(variance);

  // `jump` stays signed (useful to display "dropped by 40" vs "rose by
  // 40"); `magnitude` is what actually gets gated — for a positive-only
  // signal (the default) a negative jump can never pass minAbsoluteJump
  // since jump itself is used unsigned in that case, matching
  // flightBaseline.ts's original behavior exactly.
  const jump = latest.value - mean;
  const magnitude = config.allowNegativeJump ? Math.abs(jump) : jump;
  if (magnitude < config.minAbsoluteJump) return { status: "normal" };

  // stdDev === 0 means a perfectly flat baseline just moved — a real
  // anomaly, but "divide by zero" isn't a number JSON can carry, so it's
  // reported as a capped sentinel (99) rather than Infinity.
  const zScore = stdDev > 0 ? Math.min(99, magnitude / stdDev) : 99;
  if (zScore < config.zScoreThreshold) return { status: "normal" };

  return {
    status: "anomaly",
    data: {
      observedValue: latest.value,
      baselineMean: Math.round(mean * 10) / 10,
      baselineStdDev: Math.round(stdDev * 10) / 10,
      sampleSize: baseline.length,
      jump: Math.round(jump * 10) / 10,
      zScore: Math.round(zScore * 10) / 10,
    },
  };
}

// Convenience defaults matching flightBaseline.ts's original constants —
// every new signal starts here and overrides only what it needs to.
export const DEFAULT_BASELINE_CONFIG: BaselineConfig = {
  lookbackDays: 30,
  minBaselineSamples: 14,
  minAbsoluteJump: 2,
  zScoreThreshold: 2.5,
  maxLatestAgeMs: 36 * 60 * 60_000,
};
