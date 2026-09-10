// Multivariate anomaly detection core — the "real ML" counterpart to
// anomalyBaseline.ts's independent per-signal z-scores. Added 2026-09-09 at
// the user's explicit request for something beyond linear regression;
// designed specifically to catch what the univariate signals structurally
// can't: a country whose score, momentum, and event count are all drifting
// up TOGETHER, each individually unremarkable, but correlated movement
// across several features at once is a real pattern.
//
// Ledoit-Wolf shrinkage, not a raw sample covariance matrix: a live check
// against production data (2026-09-09) found country_state_history has at
// most ~8 rows per country (the table itself is 6 days old) — nowhere near
// enough to estimate a 5-feature covariance matrix reliably on its own (a
// raw sample covariance needs several times the feature count in samples
// before it stabilizes, and can be singular outright below that). Shrinkage
// toward a scaled-identity target is the standard, well-established fix for
// exactly this small-sample regime (Ledoit & Wolf, "Honey, I Shrunk the
// Sample Covariance Matrix," 2004) — it doesn't manufacture information
// that isn't there (MIN_BASELINE_SAMPLES below still gates on a real
// minimum), but it makes the estimate usable much sooner, and more
// robustly, than a naive covariance matrix would allow.

export interface MultivariateSample {
  vector: number[];
  at: Date;
}

export interface MultivariateBaselineConfig {
  // Comfortably above the feature count (a k-feature covariance matrix is
  // mathematically estimable from k+1 samples, but numerically unreliable
  // well beyond that point) — matches this codebase's existing pattern of
  // setting a real floor, not just "technically enough to compute."
  minBaselineSamples: number;
  maxLatestAgeMs: number;
  // Chi-squared critical value for this vector's degrees of freedom (=
  // vector length) at the caller's chosen confidence level — this module
  // doesn't hardcode a feature count, so the caller supplies the right
  // table value (see COUNTRY_STATE_CHI_SQUARED_P99 in
  // countryStateMultivariateAnomaly.ts for the one live caller's value).
  chiSquaredThreshold: number;
}

export interface MultivariateBaselineResult {
  observedVector: number[];
  meanVector: number[];
  // Per-feature (x_i - mean_i) / sqrt(cov_ii) — interpretability only (which
  // individual feature moved most), NOT what's actually tested for
  // significance. The real test is mahalanobisDistance against
  // chiSquaredThreshold, which accounts for correlation between features;
  // a feature can have a small per-feature z-score and still contribute to
  // a real multivariate anomaly if it moved in an unusual COMBINATION with
  // another feature.
  perFeatureZScore: number[];
  mahalanobisDistance: number;
  mahalanobisDistanceSquared: number;
  shrinkageIntensity: number; // 0 = pure sample covariance, 1 = pure identity target
  sampleSize: number;
}

export type MultivariateAnomalyOutcome =
  | { status: "anomaly"; data: MultivariateBaselineResult }
  | { status: "insufficient-baseline"; sampleSize: number; needed: number }
  | { status: "stale"; ageMs: number; maxAgeMs: number }
  // Distinct from insufficient-baseline: a real numerical failure (the
  // shrunk covariance matrix still isn't invertible) rather than "not
  // enough history yet" — same "don't collapse distinct failure modes into
  // one bucket" discipline anomalyBaseline.ts's own AnomalyOutcome already
  // follows for stale-vs-insufficient. Mathematically rare once shrinkage
  // is applied (see computeShrunkCovariance's own comment) but worth
  // surfacing distinctly if it ever happens rather than silently
  // misreporting it as either of the other two statuses.
  | { status: "singular-covariance" }
  | { status: "normal" };

interface CholeskyResult {
  success: boolean;
  L: number[][]; // lower-triangular factor, Sigma = L L^T
}

// Cholesky decomposition — the natural, numerically stable choice for a
// symmetric positive-(semi)definite matrix like a covariance matrix
// (versus a general-purpose Gauss-Jordan inverse, which doesn't exploit or
// verify that structure). Failure (a non-positive diagonal pivot) is
// itself the signal that the matrix isn't actually positive definite —
// exactly the "singular-covariance" case above, not a bug to silently
// paper over with a fallback epsilon.
function cholesky(matrix: number[][]): CholeskyResult {
  const n = matrix.length;
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = matrix[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (sum <= 1e-12) return { success: false, L };
        L[i][j] = Math.sqrt(sum);
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }
  return { success: true, L };
}

// Solves L L^T x = b for x, given the Cholesky factor L — used both to
// compute the Mahalanobis distance (b = observed - mean) and, via repeated
// solves against unit vectors, the full inverse when per-feature z-scores
// need the diagonal of the covariance matrix itself (not its inverse).
function choleskySolve(L: number[][], b: number[]): number[] {
  const n = L.length;
  // Forward substitution: L y = b
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= L[i][k] * y[k];
    y[i] = sum / L[i][i];
  }
  // Back substitution: L^T x = y
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= L[k][i] * x[k];
    x[i] = sum / L[i][i];
  }
  return x;
}

function mean(vectors: number[][]): number[] {
  const n = vectors.length;
  const k = vectors[0].length;
  const m = new Array(k).fill(0);
  for (const v of vectors) for (let i = 0; i < k; i++) m[i] += v[i] / n;
  return m;
}

function sampleCovariance(vectors: number[][], meanVector: number[]): number[][] {
  const n = vectors.length;
  const k = meanVector.length;
  const cov: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const v of vectors) {
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) {
        cov[i][j] += (v[i] - meanVector[i]) * (v[j] - meanVector[j]);
      }
    }
  }
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) cov[i][j] /= n - 1;
  return cov;
}

function frobeniusNormSquared(a: number[][]): number {
  let sum = 0;
  for (const row of a) for (const v of row) sum += v * v;
  return sum;
}

function matSub(a: number[][], b: number[][]): number[][] {
  return a.map((row, i) => row.map((v, j) => v - b[i][j]));
}

// Ledoit-Wolf shrinkage toward a scaled-identity target mu*I, where
// mu = trace(S)/k (the average variance across features, assuming no
// covariance in the target — a standard, conservative default). Formula
// per Ledoit & Wolf (2004): shrinkage intensity delta = b^2/d^2, where d^2
// is the squared Frobenius distance between S and the target, and b^2 is
// the average squared Frobenius distance between each sample's own outer
// product and S (an estimate of S's own estimation error) capped at d^2.
// The shrunk estimate is delta*(mu*I) + (1-delta)*S — a convex combination
// that is provably positive definite whenever mu > 0 and delta > 0 (mu*I is
// positive definite, S is always positive semi-definite), which is why
// "singular-covariance" should be rare in practice once real data flows
// through this — see the type's own comment.
function computeShrunkCovariance(
  vectors: number[][],
  meanVector: number[],
): { covariance: number[][]; shrinkageIntensity: number } {
  const n = vectors.length;
  const k = meanVector.length;
  const S = sampleCovariance(vectors, meanVector);

  const mu = S.reduce((sum, row, i) => sum + row[i], 0) / k;
  const target: number[][] = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => (i === j ? mu : 0)),
  );
  const dSquared = frobeniusNormSquared(matSub(S, target));

  // Average squared Frobenius distance between each sample's own outer
  // product (centered) and S — the standard Ledoit-Wolf estimation-error
  // term, computed directly from the same centered vectors already in hand
  // rather than a second pass over the raw data.
  let bBarSquaredSum = 0;
  for (const v of vectors) {
    const outer: number[][] = Array.from({ length: k }, (_, i) =>
      Array.from({ length: k }, (_, j) => (v[i] - meanVector[i]) * (v[j] - meanVector[j])),
    );
    bBarSquaredSum += frobeniusNormSquared(matSub(outer, S));
  }
  const bBarSquared = bBarSquaredSum / (n * n);
  const bSquared = Math.min(bBarSquared, dSquared);
  // dSquared === 0 means S already exactly equals the target (a perfectly
  // uncorrelated, equal-variance baseline) — no shrinkage needed or
  // meaningful; delta is defined as 0 in that degenerate case.
  const shrinkageIntensity = dSquared > 0 ? bSquared / dSquared : 0;

  const covariance: number[][] = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => shrinkageIntensity * target[i][j] + (1 - shrinkageIntensity) * S[i][j]),
  );

  return { covariance, shrinkageIntensity };
}

// `samples` must be sorted newest-first, and `latest` (already separated
// from `baseline`) must NOT be included in the baseline it's tested
// against — same "today's observation doesn't get to inform its own
// baseline" discipline as anomalyBaseline.ts's detectAnomaly.
export function detectMultivariateAnomaly(
  samples: MultivariateSample[],
  config: MultivariateBaselineConfig,
): MultivariateAnomalyOutcome {
  const [latest, ...baseline] = samples;
  if (!latest || baseline.length < config.minBaselineSamples) {
    return { status: "insufficient-baseline", sampleSize: baseline.length, needed: config.minBaselineSamples };
  }

  const ageMs = Date.now() - latest.at.getTime();
  if (ageMs > config.maxLatestAgeMs) {
    return { status: "stale", ageMs, maxAgeMs: config.maxLatestAgeMs };
  }

  const vectors = baseline.map((b) => b.vector);
  const meanVector = mean(vectors);
  const { covariance, shrinkageIntensity } = computeShrunkCovariance(vectors, meanVector);

  const { success, L } = cholesky(covariance);
  if (!success) return { status: "singular-covariance" };

  const diff = latest.vector.map((x, i) => x - meanVector[i]);
  const solved = choleskySolve(L, diff);
  const mahalanobisDistanceSquared = diff.reduce((sum, d, i) => sum + d * solved[i], 0);
  const mahalanobisDistance = Math.sqrt(Math.max(0, mahalanobisDistanceSquared));

  const perFeatureZScore = diff.map((d, i) => {
    const variance = covariance[i][i];
    return variance > 0 ? d / Math.sqrt(variance) : 0;
  });

  if (mahalanobisDistanceSquared < config.chiSquaredThreshold) return { status: "normal" };

  return {
    status: "anomaly",
    data: {
      observedVector: latest.vector,
      meanVector: meanVector.map((v) => Math.round(v * 1000) / 1000),
      perFeatureZScore: perFeatureZScore.map((v) => Math.round(v * 100) / 100),
      mahalanobisDistance: Math.round(mahalanobisDistance * 100) / 100,
      mahalanobisDistanceSquared: Math.round(mahalanobisDistanceSquared * 100) / 100,
      shrinkageIntensity: Math.round(shrinkageIntensity * 1000) / 1000,
      sampleSize: baseline.length,
    },
  };
}
