// Gradient-boosted regression trees — hand-rolled, same "no ML dependency"
// bar as linearRegression.ts (package.json has zero ML libraries; this
// project holds new dependencies to a "small, well-known, single-purpose,
// or don't add it" bar this data scale doesn't clear). Project 4
// (2026-09-09, "real ML" beyond linear regression): a genuine challenger
// to riskModel.ts's linear regression, trained on the exact same
// examples/split, compared on the exact same held-out backtest MAE — see
// riskModel.ts for how the two compete (whichever wins per horizon is
// what actually gets served).
//
// Squared-error loss specifically: under L2 loss, gradient boosting's
// "fit the negative gradient" step reduces exactly to "fit the residual"
// (this is a standard, well-known simplification of the general gradient-
// boosting algorithm for this one loss function, not a shortcut being
// taken here) — so each new tree is trained directly against
// (actual - current ensemble prediction), no separate gradient
// computation needed.
export interface TreeNode {
  isLeaf: boolean;
  value: number; // leaf: the prediction. internal: unused (0)
  featureIndex: number; // internal only
  threshold: number; // internal only
  left: TreeNode | null;
  right: TreeNode | null;
}

export interface TreeConfig {
  maxDepth: number;
  minSamplesLeaf: number;
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function sse(values: number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  return values.reduce((s, v) => s + (v - m) ** 2, 0);
}

function makeLeaf(value: number): TreeNode {
  return { isLeaf: true, value, featureIndex: -1, threshold: 0, left: null, right: null };
}

// Standard CART-style regression tree: at each node, tries every feature
// and every candidate threshold (midpoints between consecutive sorted
// unique values — the full, correct candidate set for a 1-D axis-aligned
// split, not a subsample), picks whichever split minimizes the sum of the
// two children's own SSE. Recurses until maxDepth or minSamplesLeaf stops
// it. minSamplesLeaf is the real regularizer at this app's data scale
// (tens of examples per horizon even at maturity) — without it, a tree
// this deep would happily carve out a single-point leaf per training
// example, memorizing rather than learning.
export function buildTree(x: number[][], y: number[], config: TreeConfig, depth = 0): TreeNode {
  if (depth >= config.maxDepth || x.length < 2 * config.minSamplesLeaf) {
    return makeLeaf(mean(y));
  }

  const nFeatures = x[0]?.length ?? 0;
  let bestFeature = -1;
  let bestThreshold = 0;
  let bestSse = sse(y); // a "split" that doesn't improve on the unsplit SSE is never chosen
  let bestLeftIdx: number[] = [];
  let bestRightIdx: number[] = [];

  for (let f = 0; f < nFeatures; f++) {
    const uniqueSorted = [...new Set(x.map((row) => row[f]))].sort((a, b) => a - b);
    for (let i = 0; i < uniqueSorted.length - 1; i++) {
      const threshold = (uniqueSorted[i] + uniqueSorted[i + 1]) / 2;
      const leftIdx: number[] = [];
      const rightIdx: number[] = [];
      for (let j = 0; j < x.length; j++) {
        (x[j][f] <= threshold ? leftIdx : rightIdx).push(j);
      }
      if (leftIdx.length < config.minSamplesLeaf || rightIdx.length < config.minSamplesLeaf) continue;

      const candidateSse = sse(leftIdx.map((j) => y[j])) + sse(rightIdx.map((j) => y[j]));
      if (candidateSse < bestSse) {
        bestSse = candidateSse;
        bestFeature = f;
        bestThreshold = threshold;
        bestLeftIdx = leftIdx;
        bestRightIdx = rightIdx;
      }
    }
  }

  if (bestFeature === -1) return makeLeaf(mean(y)); // no split improves on a leaf here

  return {
    isLeaf: false,
    value: 0,
    featureIndex: bestFeature,
    threshold: bestThreshold,
    left: buildTree(bestLeftIdx.map((i) => x[i]), bestLeftIdx.map((i) => y[i]), config, depth + 1),
    right: buildTree(bestRightIdx.map((i) => x[i]), bestRightIdx.map((i) => y[i]), config, depth + 1),
  };
}

export function predictTree(node: TreeNode, x: number[]): number {
  if (node.isLeaf) return node.value;
  return x[node.featureIndex] <= node.threshold ? predictTree(node.left!, x) : predictTree(node.right!, x);
}

export interface GbmModel {
  initialPrediction: number; // F_0 = mean(y) on the training set
  trees: TreeNode[];
  learningRate: number;
  maxDepth: number;
  minSamplesLeaf: number;
}

export interface GbmTrainConfig {
  // Candidates for the nested hyperparameter search below — deliberately
  // conservative ranges (shallow trees, modest ensemble sizes) given this
  // app's real per-horizon data scale (tens of examples even at maturity,
  // per riskModel.ts's own MIN_TRAINING_SAMPLE), not because shallower is
  // inherently better.
  nEstimatorsCandidates: number[];
  maxDepthCandidates: number[];
  learningRate: number;
  minSamplesLeaf: number;
  // Same deterministic (every-Nth-index, not random) inner train/
  // validation split discipline as linearRegression.ts's own L2 search —
  // reproducible, and never touches the true held-out backtest split.
  validationFraction: number;
}

export const DEFAULT_GBM_CONFIG: GbmTrainConfig = {
  nEstimatorsCandidates: [10, 25, 50],
  maxDepthCandidates: [1, 2, 3],
  learningRate: 0.1,
  minSamplesLeaf: 3,
  validationFraction: 0.25,
};

const MIN_SEARCH_SPLIT_SIZE = 4;

function fitGbm(x: number[][], y: number[], nEstimators: number, maxDepth: number, config: GbmTrainConfig): GbmModel {
  const initialPrediction = mean(y);
  const currentPredictions = new Array(y.length).fill(initialPrediction);
  const trees: TreeNode[] = [];

  for (let t = 0; t < nEstimators; t++) {
    const residuals = y.map((yi, i) => yi - currentPredictions[i]);
    const tree = buildTree(x, residuals, { maxDepth, minSamplesLeaf: config.minSamplesLeaf });
    trees.push(tree);
    for (let i = 0; i < x.length; i++) {
      currentPredictions[i] += config.learningRate * predictTree(tree, x[i]);
    }
  }

  return { initialPrediction, trees, learningRate: config.learningRate, maxDepth, minSamplesLeaf: config.minSamplesLeaf };
}

export function predictGbm(model: GbmModel, x: number[]): number {
  let pred = model.initialPrediction;
  for (const tree of model.trees) pred += model.learningRate * predictTree(tree, x);
  return pred;
}

function meanAbsError(model: GbmModel, x: number[][], y: number[]): number {
  if (x.length === 0) return Infinity;
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += Math.abs(predictGbm(model, x[i]) - y[i]);
  return sum / x.length;
}

export interface GbmTrainOutput {
  model: GbmModel;
  selectedNEstimators: number;
  selectedMaxDepth: number;
}

// `x`/`y` = the OUTER training set, already time-split by the caller
// (riskModel.ts) — same leak-free discipline as linearRegression.ts.
// Selects (nEstimators, maxDepth) jointly via a nested split of ITS OWN,
// never the real backtest split, then refits on the full outer set with
// the winning pair. Trees are scale-invariant to monotonic feature
// transforms, so unlike linear regression this doesn't standardize
// features first — there's no equivalent benefit here, and skipping it is
// a real simplification, not an oversight.
export function trainGradientBoostedTrees(
  x: number[][],
  y: number[],
  config: GbmTrainConfig = DEFAULT_GBM_CONFIG,
): GbmTrainOutput {
  const n = x.length;
  const step = Math.max(1, Math.round(1 / config.validationFraction));
  const innerTrainX: number[][] = [];
  const innerTrainY: number[] = [];
  const valX: number[][] = [];
  const valY: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i % step === 0) {
      valX.push(x[i]);
      valY.push(y[i]);
    } else {
      innerTrainX.push(x[i]);
      innerTrainY.push(y[i]);
    }
  }

  // Safest defaults if the split is too small to search reliably: the
  // smallest/most-regularized candidates (fewest trees, shallowest depth)
  // — same "fall back to the safest choice, not the riskiest one"
  // reasoning as linearRegression.ts's own MIN_SEARCH_SPLIT_SIZE fallback.
  let selectedNEstimators = config.nEstimatorsCandidates[0];
  let selectedMaxDepth = config.maxDepthCandidates[0];

  if (innerTrainX.length >= MIN_SEARCH_SPLIT_SIZE && valX.length >= MIN_SEARCH_SPLIT_SIZE) {
    let bestValLoss = Infinity;
    for (const nEstimators of config.nEstimatorsCandidates) {
      for (const maxDepth of config.maxDepthCandidates) {
        const candidate = fitGbm(innerTrainX, innerTrainY, nEstimators, maxDepth, config);
        const valLoss = meanAbsError(candidate, valX, valY);
        if (valLoss < bestValLoss) {
          bestValLoss = valLoss;
          selectedNEstimators = nEstimators;
          selectedMaxDepth = maxDepth;
        }
      }
    }
  }

  const model = fitGbm(x, y, selectedNEstimators, selectedMaxDepth, config);
  return { model, selectedNEstimators, selectedMaxDepth };
}

// Mirrors linearRegression.ts's RegressionBacktestMetrics shape exactly —
// riskModel.ts compares the two models' MAE directly, so the shapes need
// to line up, not just resemble each other.
export interface GbmBacktestMetrics {
  sampleSize: number;
  mae: number;
  rmse: number;
  naiveMae: number;
}

export function evaluateGbmBacktest(
  model: GbmModel,
  xTest: number[][],
  yTest: number[],
  naivePredictions: number[],
): GbmBacktestMetrics {
  const n = xTest.length;
  if (n === 0) return { sampleSize: 0, mae: 0, rmse: 0, naiveMae: 0 };

  let sqErrSum = 0;
  let absErrSum = 0;
  let naiveAbsErrSum = 0;
  for (let i = 0; i < n; i++) {
    const pred = predictGbm(model, xTest[i]);
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
