// Generic logistic regression core — hand-rolled rather than a dependency
// (package.json has zero ML libraries, and this project holds new
// dependencies to a "small, well-known, single-purpose, or don't add it"
// bar — see gpsjam.ts's h3-js doc comment; at the data scale this app
// actually has, even that bar isn't cleared, so this stays plain TS).
// Not risk-specific — mirrors how anomalyBaseline.ts was built as a
// reusable core rather than embedded in its one caller, so a future
// second binary-classification use case doesn't reimplement this.
export interface LogisticRegressionModel {
  weights: number[]; // one per feature, in the same order as training
  bias: number;
  featureMeans: number[];
  featureStdDevs: number[];
}

export interface TrainConfig {
  iterations: number;
  learningRate: number;
  // L2 penalty — deliberately on by default, not an opt-in. With few
  // training examples (this app's actual near-term reality), an
  // unregularized fit can drive weights arbitrarily large chasing a
  // handful of points exactly, producing extreme, overconfident
  // probabilities on new data. A modest L2 term keeps early fits
  // conservative instead — matters most exactly when data is thinnest.
  l2: number;
}

export const DEFAULT_TRAIN_CONFIG: TrainConfig = {
  iterations: 500,
  learningRate: 0.1,
  l2: 0.1,
};

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
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
    // A feature that's constant across every training row (stddev 0)
    // would otherwise divide by zero — treat it as already-scaled (no-op)
    // rather than crash; its weight will just correctly learn to be ~0
    // since it carries no discriminating information anyway.
    if (stdDevs[j] === 0) stdDevs[j] = 1;
  }

  const standardized = rows.map((row) => row.map((v, j) => (v - means[j]) / stdDevs[j]));
  return { means, stdDevs, standardized };
}

// `x` = feature matrix (one row per example), `y` = labels (0/1), same
// row order. Batch gradient descent on log-loss + L2 — deterministic,
// no adaptive optimizer needed at this data scale (low hundreds of rows
// even once mature).
export function trainLogisticRegression(
  x: number[][],
  y: number[],
  config: TrainConfig = DEFAULT_TRAIN_CONFIG,
): LogisticRegressionModel {
  const { means, stdDevs, standardized } = standardize(x);
  const n = standardized.length;
  const dims = standardized[0]?.length ?? 0;

  let weights = new Array(dims).fill(0);
  let bias = 0;

  for (let iter = 0; iter < config.iterations; iter++) {
    const weightGrad = new Array(dims).fill(0);
    let biasGrad = 0;

    for (let i = 0; i < n; i++) {
      const z = standardized[i].reduce((sum, v, j) => sum + v * weights[j], bias);
      const pred = sigmoid(z);
      const error = pred - y[i];
      for (let j = 0; j < dims; j++) weightGrad[j] += (error * standardized[i][j]) / n;
      biasGrad += error / n;
    }

    // L2 penalty applied to weights only, never the bias/intercept — a
    // standard convention (shrinking the bias toward 0 has no
    // regularizing benefit, it just biases predictions toward 50/50
    // regardless of class balance).
    weights = weights.map((w, j) => w - config.learningRate * (weightGrad[j] + config.l2 * w));
    bias = bias - config.learningRate * biasGrad;
  }

  return { weights, bias, featureMeans: means, featureStdDevs: stdDevs };
}

export function predictProbability(model: LogisticRegressionModel, features: number[]): number {
  const standardized = features.map(
    (v, j) => (v - model.featureMeans[j]) / model.featureStdDevs[j],
  );
  const z = standardized.reduce((sum, v, j) => sum + v * model.weights[j], model.bias);
  return sigmoid(z);
}

export interface BacktestMetrics {
  sampleSize: number;
  accuracy: number;
  precision: number | null; // null when the test split has 0 predicted positives
  recall: number | null; // null when the test split has 0 actual positives
}

// `threshold` defaults to 0.5 (the standard midpoint) — this app has no
// basis yet for a different operating point, and picking one without
// real precision/recall tradeoff data to justify it would itself be a
// kind of false precision.
export function evaluateBacktest(
  model: LogisticRegressionModel,
  xTest: number[][],
  yTest: number[],
  threshold = 0.5,
): BacktestMetrics {
  let truePos = 0;
  let falsePos = 0;
  let trueNeg = 0;
  let falseNeg = 0;

  for (let i = 0; i < xTest.length; i++) {
    const predicted = predictProbability(model, xTest[i]) >= threshold ? 1 : 0;
    const actual = yTest[i];
    if (predicted === 1 && actual === 1) truePos++;
    else if (predicted === 1 && actual === 0) falsePos++;
    else if (predicted === 0 && actual === 0) trueNeg++;
    else falseNeg++;
  }

  const sampleSize = xTest.length;
  const accuracy = sampleSize > 0 ? (truePos + trueNeg) / sampleSize : 0;
  const precision = truePos + falsePos > 0 ? truePos / (truePos + falsePos) : null;
  const recall = truePos + falseNeg > 0 ? truePos / (truePos + falseNeg) : null;

  return { sampleSize, accuracy, precision, recall };
}
