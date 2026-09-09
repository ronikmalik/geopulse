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
  maxIterations: number;
  learningRate: number;
  // Early stopping, not a fixed iteration count — checked every N
  // iterations, stops once improvement falls below tolerance. Robust to
  // horizons that converge faster or slower than each other, rather than
  // one guessed count assumed to suit all of them equally.
  convergenceCheckEvery: number;
  convergenceTolerance: number;
  // Fraction of the (already time-split, leak-free) outer training set
  // held out — deterministically, not randomly (see trainLinearRegression)
  // — for L2 selection only. Never the real backtest split.
  validationFraction: number;
}

export const DEFAULT_TRAIN_CONFIG: TrainConfig = {
  l2Candidates: [0.01, 0.1, 1, 3, 10],
  maxIterations: 2000,
  learningRate: 0.1,
  convergenceCheckEvery: 25,
  convergenceTolerance: 1e-5,
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

// Batch gradient descent on squared error + L2, both in already-
// standardized space. Early-stops rather than always running the full
// iteration cap.
function fitOnce(
  x: number[][],
  y: number[],
  l2: number,
  config: TrainConfig,
): FitResult {
  const n = x.length;
  const dims = x[0]?.length ?? 0;
  let weights = new Array(dims).fill(0);
  let bias = 0;
  let prevLoss = Infinity;

  for (let iter = 0; iter < config.maxIterations; iter++) {
    const weightGrad = new Array(dims).fill(0);
    let biasGrad = 0;
    let sqErrSum = 0;

    for (let i = 0; i < n; i++) {
      const pred = x[i].reduce((sum, v, j) => sum + v * weights[j], bias);
      const error = pred - y[i];
      sqErrSum += error * error;
      for (let j = 0; j < dims; j++) weightGrad[j] += (error * x[i][j]) / n;
      biasGrad += error / n;
    }

    weights = weights.map((w, j) => w - config.learningRate * (weightGrad[j] + l2 * w));
    bias = bias - config.learningRate * biasGrad;

    if ((iter + 1) % config.convergenceCheckEvery === 0) {
      const loss = sqErrSum / n;
      if (Math.abs(prevLoss - loss) < config.convergenceTolerance) break;
      prevLoss = loss;
    }
  }

  return { weights, bias };
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

// `x`/`y` = the OUTER training set — already time-split by the caller
// (riskModel.ts) to avoid leaking future information into the real
// backtest. This function standardizes, selects L2 via a nested split of
// ITS OWN (deterministic — every Nth example by validationFraction, not
// random, so a re-run on the same data reproduces the same result), and
// refits on the full outer set with the winning L2.
export function trainLinearRegression(
  x: number[][],
  y: number[],
  config: TrainConfig = DEFAULT_TRAIN_CONFIG,
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
    if (i % step === 0) {
      valX.push(xStd[i]);
      valY.push(yStd[i]);
    } else {
      innerTrainX.push(xStd[i]);
      innerTrainY.push(yStd[i]);
    }
  }

  let selectedL2 = config.l2Candidates[config.l2Candidates.length - 1]; // safest default: most regularization
  if (innerTrainX.length >= MIN_SEARCH_SPLIT_SIZE && valX.length >= MIN_SEARCH_SPLIT_SIZE) {
    let bestValLoss = Infinity;
    for (const l2 of config.l2Candidates) {
      const fit = fitOnce(innerTrainX, innerTrainY, l2, config);
      const valLoss = meanAbsErrorOf(fit, valX, valY);
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
