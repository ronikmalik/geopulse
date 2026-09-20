// Generic linear regression core — hand-rolled, no dependency (same
// reasoning as the logistic regression module this replaces: package.json
// has zero ML libraries, and this project holds new dependencies to a
// "small, well-known, single-purpose, or don't add it" bar this data
// scale doesn't clear). Replaced logistic regression outright (2026-09-09,
// user request): the shadow risk model now predicts a country's actual
// future score over several horizons, not a binary escalation flag —
// regression, not classification. `riskModel.ts` was the sole importer of
// the old module.
export interface LinearRegressionModel {
  weights: number[];
  bias: number;
  featureMeans: number[];
  featureStdDevs: number[];
  // Standardizing the TARGET too, not just the features — score's natural
  // scale (0 to 30+, per threat.ts's own bucket thresholds) is far wider
  // than a bounded loss would assume, so fitting on raw-scale error would
  // need its own separately-tuned learning rate per horizon. Standardizing
  // both sides keeps one shared rate/iteration policy sufficient
  // regardless of a given horizon's target scale.
  targetMean: number;
  targetStdDev: number;
}

export interface TrainConfig {
  // L2 strength is SELECTED from these candidates via nested validation
  // (see trainLinearRegression), not fixed to one guessed value — the
  // right amount of regularization depends on how much real signal a
  // given horizon's data actually has, which nothing here should assume
  // in advance.
  l2Candidates: number[];
  // Fraction of the (already time-split, leak-free) outer training set
  // held out — deterministically, not randomly (see trainLinearRegression)
  // — for L2 selection only. Never the real backtest split.
  validationFraction: number;
}

export const DEFAULT_TRAIN_CONFIG: TrainConfig = {
  l2Candidates: [0.01, 0.1, 1, 3, 10],
  validationFraction: 0.25,
};

// Below this many points per side, a train/validation split for L2
// selection is too noisy to trust — falls back to the safest (largest,
// most conservative) candidate instead of searching on a handful of
// points that could favor an under-regularized fit by chance.
const MIN_SEARCH_SPLIT_SIZE = 4;

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function standardize(
  rows: number[][],
): { means: number[]; stdDevs: number[]; standardized: number[][] } {
  const n = rows.length;
  const dims = rows[0]?.length ?? 0;
  const means = new Array(dims).fill(0);
  for (const row of rows) for (let j = 0; j < dims; j++) means[j] += row[j] / n;

  const stdDevs = new Array(dims).fill(0);
  for (const row of rows) for (let j = 0; j < dims; j++) stdDevs[j] += (row[j] - means[j]) ** 2 / n;
  for (let j = 0; j < dims; j++) {
    stdDevs[j] = Math.sqrt(stdDevs[j]);
    // A feature constant across every row (stddev 0) would divide by
    // zero — treat it as already-scaled; its weight correctly learns ~0
    // since it carries no discriminating information anyway.
    if (stdDevs[j] === 0) stdDevs[j] = 1;
  }

  const standardized = rows.map((row) => row.map((v, j) => (v - means[j]) / stdDevs[j]));
  return { means, stdDevs, standardized };
}

interface FitResult {
  weights: number[];
  bias: number;
}

// Exact ridge solution (2026-09-20) — replaced the batch gradient descent
// that was here. Objective is unchanged: minimize (1/n)·Σ(x·w + b − y)² +
// l2·‖w‖² in already-standardized space, which in closed form is
// w = (XᵀX/n + l2·I)⁻¹ Xᵀy/n with b = 0 (both sides are zero-mean). With
// at most a few dozen features this is a tiny symmetric solve, so there
// is no learning rate, no iteration cap and no convergence tolerance to
// tune — and no way for them to interact badly. That interaction was
// real: the old update w ← w − lr·(grad + l2·w) with lr = 0.1 and l2 = 10
// multiplied the weights by exactly zero every step, so the "safest"
// fallback candidate produced a model that could only predict the mean
// (MAE 31.7 vs. persistence 2.98 on 2026-09-20's run). The fallback is
// still the largest candidate; it is just now a real ridge fit.
function fitOnce(
  x: number[][],
  y: number[],
  l2: number,
  _config: TrainConfig,
): FitResult {
  const n = x.length;
  const dims = x[0]?.length ?? 0;
  if (n === 0 || dims === 0) return { weights: new Array(dims).fill(0), bias: 0 };

  // A = XᵀX/n + l2·I, rhs = Xᵀy/n
  const a: number[][] = Array.from({ length: dims }, () => new Array(dims).fill(0));
  const rhs = new Array(dims).fill(0);
  for (let i = 0; i < n; i++) {
    const row = x[i];
    for (let j = 0; j < dims; j++) {
      rhs[j] += (row[j] * y[i]) / n;
      for (let k = j; k < dims; k++) a[j][k] += (row[j] * row[k]) / n;
    }
  }
  for (let j = 0; j < dims; j++) {
    for (let k = 0; k < j; k++) a[j][k] = a[k][j];
    a[j][j] += l2;
  }
  return { weights: solveSymmetric(a, rhs), bias: 0 };
}

// Gaussian elimination with partial pivoting on a small dense system.
// The ridge term makes A strictly positive definite, so a zero pivot can
// only come from a degenerate all-constant feature — those are already
// mapped to a unit std-dev by standardize(), and a truly zero row gets a
// zero weight rather than NaN.
function solveSymmetric(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) continue;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
}

function meanAbsErrorOf(fit: FitResult, x: number[][], y: number[]): number {
  if (x.length === 0) return Infinity;
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    const pred = x[i].reduce((s, v, j) => s + v * fit.weights[j], fit.bias);
    sum += Math.abs(pred - y[i]);
  }
  return sum / x.length;
}

export interface TrainOutput {
  model: LinearRegressionModel;
  selectedL2: number;
}

// Select L2 on the caller's inner split, then refit on all outer training
// rows. riskModel supplies a purged temporal split; generic callers without
// timestamps retain deterministic every-Nth validation. Inner scaling uses
// only inner training rows, while final scaling uses the outer training set.
export function trainLinearRegression(
  x: number[][],
  y: number[],
  config: TrainConfig = DEFAULT_TRAIN_CONFIG,
  validationSplit?: { train: number[]; test: number[] },
): TrainOutput {
  const { means: featureMeans, stdDevs: featureStdDevs, standardized: xStd } = standardize(x);
  const targetMean = mean(y);
  const targetVariance = y.reduce((sum, v) => sum + (v - targetMean) ** 2, 0) / y.length;
  const targetStdDev = Math.sqrt(targetVariance) || 1;
  const yStd = y.map((v) => (v - targetMean) / targetStdDev);

  const n = xStd.length;
  const step = Math.max(1, Math.round(1 / config.validationFraction));
  const innerTrainX: number[][] = [];
  const innerTrainY: number[] = [];
  const valX: number[][] = [];
  const valY: number[] = [];
  for (let i = 0; i < n; i++) {
    if (validationSplit ? validationSplit.test.includes(i) : i % step === 0) {
      valX.push(x[i]);
      valY.push(y[i]);
    } else if (!validationSplit || validationSplit.train.includes(i)) {
      innerTrainX.push(x[i]);
      innerTrainY.push(y[i]);
    }
  }

  let selectedL2 = config.l2Candidates[config.l2Candidates.length - 1]; // safest default: most regularization
  if (innerTrainX.length >= MIN_SEARCH_SPLIT_SIZE && valX.length >= MIN_SEARCH_SPLIT_SIZE) {
    // Fit every preprocessing statistic on the inner training subset.
    // Validation labels/features must not influence these statistics.
    const inner = standardize(innerTrainX);
    const innerMean = mean(innerTrainY);
    const innerStd = Math.sqrt(innerTrainY.reduce((sum, value) => sum + (value - innerMean) ** 2, 0) / innerTrainY.length) || 1;
    const innerY = innerTrainY.map((value) => (value - innerMean) / innerStd);
    const validationX = valX.map((row) => row.map((value, j) => (value - inner.means[j]) / inner.stdDevs[j]));
    const validationY = valY.map((value) => (value - innerMean) / innerStd);
    let bestValLoss = Infinity;
    for (const l2 of config.l2Candidates) {
      const fit = fitOnce(inner.standardized, innerY, l2, config);
      const valLoss = meanAbsErrorOf(fit, validationX, validationY);
      if (valLoss < bestValLoss) {
        bestValLoss = valLoss;
        selectedL2 = l2;
      }
    }
  }

  const finalFit = fitOnce(xStd, yStd, selectedL2, config);
  return {
    model: {
      weights: finalFit.weights,
      bias: finalFit.bias,
      featureMeans,
      featureStdDevs,
      targetMean,
      targetStdDev,
    },
    selectedL2,
  };
}

export function predict(model: LinearRegressionModel, features: number[]): number {
  const standardized = features.map(
    (v, j) => (v - model.featureMeans[j]) / model.featureStdDevs[j],
  );
  const zStd = standardized.reduce((sum, v, j) => sum + v * model.weights[j], model.bias);
  return zStd * model.targetStdDev + model.targetMean;
}

export interface RegressionBacktestMetrics {
  sampleSize: number;
  mae: number;
  rmse: number;
  // The naive "predict no change" baseline's own MAE, computed alongside
  // the model's — a forecasting model with no comparison point is a
  // number without context. See riskModel.ts for how naivePredictions is
  // constructed (the country's own current score at prediction time).
  naiveMae: number;
}

export function evaluateRegressionBacktest(
  model: LinearRegressionModel,
  xTest: number[][],
  yTest: number[],
  naivePredictions: number[],
): RegressionBacktestMetrics {
  const n = xTest.length;
  if (n === 0) return { sampleSize: 0, mae: 0, rmse: 0, naiveMae: 0 };

  let sqErrSum = 0;
  let absErrSum = 0;
  let naiveAbsErrSum = 0;
  for (let i = 0; i < n; i++) {
    const pred = predict(model, xTest[i]);
    const err = pred - yTest[i];
    sqErrSum += err * err;
    absErrSum += Math.abs(err);
    naiveAbsErrSum += Math.abs(naivePredictions[i] - yTest[i]);
  }

  return {
    sampleSize: n,
    mae: absErrSum / n,
    rmse: Math.sqrt(sqErrSum / n),
    naiveMae: naiveAbsErrSum / n,
  };
}
