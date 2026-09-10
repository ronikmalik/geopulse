import {
  fetchSnapshotsSince,
  fetchAnomaliesSince,
  featuresFor,
  groupByCountryPastBurnIn,
  FEATURE_NAMES,
  TRAINING_DATA_START,
} from "@/lib/riskModel";
import {
  detectMultivariateAnomaly,
  type MultivariateAnomalyOutcome,
  type MultivariateSample,
} from "@/lib/multivariateAnomaly";

// Project 2 (2026-09-09, user request for "real ML" beyond linear
// regression): multivariate anomaly detection over the same per-country
// feature vector riskModel.ts already computes for forecasting — a
// different question asked of the same data (deviation from a country's
// own normal, not prediction of its future). Reuses fetchSnapshotsSince/
// fetchAnomaliesSince/featuresFor/groupByCountryPastBurnIn/FEATURE_NAMES/
// TRAINING_DATA_START directly from riskModel.ts rather than a second copy
// — see that file's own comments on each export for why sharing matters
// (the cold-start burn-in problem and the feature-vector definition are
// the same underlying facts for both models).
//
// threatLevel is deliberately DROPPED from the vector used here (kept in
// riskModel.ts's own FEATURE_NAMES for forecasting, where it's a harmless
// duplicate signal) — threat.ts's weightToThreatLevel makes threatLevel a
// step function of score, near-perfectly correlated with it in practice,
// which would make the covariance matrix this signal depends on
// ill-conditioned. The remaining 5 features (score, momentum,
// momentumDirection, eventCount, anomalyCount7d) don't share that problem:
// momentum (magnitude) and momentumDirection (sign) are genuinely
// different axes of information, not a duplicate of each other, the same
// way a vector's length and direction aren't redundant with one another.
const THREAT_LEVEL_INDEX = FEATURE_NAMES.indexOf("threatLevel");
const MULTIVARIATE_FEATURE_NAMES = FEATURE_NAMES.filter((_, i) => i !== THREAT_LEVEL_INDEX);

// A live check against production data (2026-09-09/10) confirmed
// EVERY country currently reports insufficient-baseline: this signal
// shares riskModel.ts's TRAINING_DATA_START + per-country burn-in
// exclusion (both correctly needed here too — the same cold-start
// climb that corrupts training examples for score-forecasting equally
// corrupts a "what's this country's normal baseline" computation), so
// nothing clears burn-in before 2026-09-16 regardless of this number.
// 15 (3x the 5-feature count) is deliberately NOT the same 20 an initial
// draft used — shrinkage exists specifically to make N-close-to-k
// regimes usable, so padding the minimum well past what shrinkage is
// designed to require would waste the whole point of choosing this
// technique. Matches this codebase's own established convention
// (anomalyBaseline.ts's DEFAULT_BASELINE_CONFIG.minBaselineSamples=14)
// rather than a freshly guessed number.
const MIN_BASELINE_SAMPLES = 15;

// A daily-cadence signal (see snapshot route) — stale if the whole day's
// snapshot cron hasn't fired, matching risk.ts's own HALF_LIFE_DAYS-scale
// reasoning for what "the cron didn't run" should look like versus "this
// data is old but real."
const MAX_LATEST_AGE_MS = 36 * 60 * 60_000;

// Chi-squared critical value at 5 degrees of freedom (the 5 features
// above), 99% confidence — standard statistical table value (Mahalanobis
// distance SQUARED follows a chi-squared distribution with k degrees of
// freedom, k = number of features, under the null hypothesis that the new
// observation is drawn from the same distribution as the baseline).
// Chosen to sit in the same rough confidence neighborhood as
// anomalyBaseline.ts's own zScoreThreshold=2.5 default (a two-tailed
// z-score of 2.5 on a standard normal corresponds to roughly 98.8%
// confidence) rather than an arbitrarily different bar for this signal.
const CHI_SQUARED_P99_DF5 = 15.086;

const ANOMALY_WINDOW_DAYS_FOR_SCAN = 30; // matches risk.ts's own LOOKBACK_DAYS

export interface MultivariateCountryOutcome {
  country: string;
  outcome: MultivariateAnomalyOutcome;
}

// Mirrors the shape every other anomalyScan.ts signal module exports (see
// getAircraftAnomalyOutcomes/getEventVolumeAnomalyOutcomes) — one outcome
// per country, computed against that country's own trailing history.
export async function getCountryStateMultivariateAnomalyOutcomes(): Promise<
  MultivariateCountryOutcome[]
> {
  const windowStart = new Date(
    Math.max(TRAINING_DATA_START.getTime(), Date.now() - ANOMALY_WINDOW_DAYS_FOR_SCAN * 86_400_000),
  );
  const [allSnapshots, anomalies] = await Promise.all([
    fetchSnapshotsSince(windowStart),
    fetchAnomaliesSince(new Date(windowStart.getTime() - 7 * 86_400_000)),
  ]);

  const byCountry = groupByCountryPastBurnIn(allSnapshots);
  const results: MultivariateCountryOutcome[] = [];

  for (const [country, sorted] of byCountry) {
    // Newest-first for detectMultivariateAnomaly, matching every other
    // signal module's own convention (each already queries with its own
    // orderBy(desc(...)) for the same reason).
    const newestFirst = [...sorted].reverse();
    const samples: MultivariateSample[] = newestFirst.map((s) => ({
      vector: featuresFor(s, anomalies).filter((_, i) => i !== THREAT_LEVEL_INDEX),
      at: s.snapshotAt,
    }));

    const outcome = detectMultivariateAnomaly(samples, {
      minBaselineSamples: MIN_BASELINE_SAMPLES,
      maxLatestAgeMs: MAX_LATEST_AGE_MS,
      chiSquaredThreshold: CHI_SQUARED_P99_DF5,
    });

    results.push({ country, outcome });
  }

  return results;
}

// Exported for callers that want the human-readable feature list
// alongside a finding's data (e.g. an admin panel rendering
// perFeatureZScore) without hardcoding a second copy of it.
export { MULTIVARIATE_FEATURE_NAMES };
