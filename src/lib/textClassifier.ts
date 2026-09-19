// Project 3 (2026-09-09, "real ML" text classifier): k-nearest-neighbors
// in embedding space, trained on classification_archive's own kept/dropped
// labels. Deliberately NOT a parametric model (a per-category logistic
// head, the way linearRegression.ts's regression works) — with ~3,000
// labeled examples in a 768-dimensional embedding space, a parametric
// model has vastly more free parameters than data to constrain them
// (exactly the overfitting risk this session already reasoned through and
// avoided for the risk model, applied to a different model shape here).
// k-NN is non-parametric — it compares directly against stored labeled
// examples rather than fitting per-dimension weights — so it doesn't carry
// that same failure mode at this data scale, while still being real,
// standard supervised ML, not a heuristic dressed up as one.
import { cosineDistance, normalize } from "@/lib/narrativeClustering";

// Contract: `embedding` on both LabeledExample and classifyViaKnn's query
// argument must ALREADY be unit-normalized before reaching this module —
// same assumption narrativeClustering.ts's own cosineDistance makes. Every
// call site here normalizes ONCE when an example is first loaded (see
// prepareLabeledExamples below), never per-comparison — chooseBestK's own
// cross-validation loop calls classifyViaKnn against the same training
// pool thousands of times, so re-normalizing a stored example's embedding
// on every single comparison (an earlier draft did exactly this) would be
// real, needless, repeated work.
export interface LabeledExample {
  id: number;
  embedding: number[]; // must be pre-normalized — see this module's own header comment
  kept: boolean;
  category: string | null; // only ever set when kept === true (see classification_archive's own schema comment)
  severity: number;
}

// Normalizes a batch of raw (from-the-database) embeddings once — the one
// place callers should call normalize() at all before using this module.
export function prepareLabeledExamples(
  raw: { id: number; embedding: number[]; kept: boolean; category: string | null; severity: number }[],
): LabeledExample[] {
  return raw.map((r) => ({ ...r, embedding: normalize(r.embedding) }));
}

// Neighbor vote weighting (2026-09-19 upgrade). "uniform" is classic
// majority vote — every one of the k neighbors counts the same whether
// it's a near-duplicate of the query or barely inside the k-radius.
// "distance" is inverse-distance weighting (sklearn's weights="distance"):
// a neighbor at cosine distance d votes with weight 1/(d + WEIGHT_EPS), so
// an almost-identical archived article (d ~ 0.01) dominates a handful of
// loosely-related ones (d ~ 0.3) instead of being outvoted by them. That
// is exactly the situation a news classifier hits constantly — the same
// story re-reported by another outlet — and where plain majority vote is
// known to under-perform. WEIGHT_EPS keeps an exact-duplicate's weight
// finite and bounds how much one neighbor can dominate (at most ~100x a
// neighbor at d=1). NEITHER is assumed better: chooseBestK cross-
// validates both against the same folds and picks the winner jointly
// with k, and the run's notes record which one won.
export type KnnWeighting = "uniform" | "distance";
export const KNN_WEIGHTINGS: readonly KnnWeighting[] = ["uniform", "distance"];
const WEIGHT_EPS = 0.01;

function neighborWeight(distance: number, weighting: KnnWeighting): number {
  return weighting === "distance" ? 1 / (distance + WEIGHT_EPS) : 1;
}

export interface ClassificationPrediction {
  relevant: boolean;
  category: string | null;
  severity: number;
  confidence: number; // fraction of the k nearest neighbors that agreed with the majority relevance vote
}

// Ties broken toward NOT relevant — matches this codebase's own
// established "precision over recall" bar for what makes it into the live
// feed (classify.ts's MIN_SEVERITY_TO_INCLUDE gate has the identical
// bias), rather than an arbitrary tie-break direction.
// `queryEmbedding` must already be normalized (see this module's header
// comment) — callers with a raw embedding should call normalize() once
// themselves, not rely on this function to do it repeatedly.
export function classifyViaKnn(
  queryEmbedding: number[],
  labeled: LabeledExample[],
  k: number,
  weighting: KnnWeighting = "uniform",
): ClassificationPrediction {
  const withDistance = labeled
    .map((ex) => ({ ex, distance: cosineDistance(queryEmbedding, ex.embedding) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, k)
    .map((n) => ({ ...n, weight: neighborWeight(n.distance, weighting) }));

  const totalWeight = withDistance.reduce((s, n) => s + n.weight, 0);
  const keptWeight = withDistance.filter((n) => n.ex.kept).reduce((s, n) => s + n.weight, 0);
  const relevant = keptWeight > totalWeight / 2;
  // Fraction of the (weighted) vote that went to the winning side — 0.5 is
  // a coin flip, 1.0 is unanimous. Under uniform weighting this is exactly
  // the old "fraction of neighbors that agreed" number.
  const confidence = totalWeight === 0 ? 0 : Math.max(keptWeight, totalWeight - keptWeight) / totalWeight;

  const keptNeighbors = withDistance.filter((n) => n.ex.kept);
  const categoryVotes = new Map<string, number>();
  for (const n of keptNeighbors) {
    if (!n.ex.category) continue;
    categoryVotes.set(n.ex.category, (categoryVotes.get(n.ex.category) ?? 0) + n.weight);
  }
  let category: string | null = null;
  let bestVotes = 0;
  for (const [cat, votes] of categoryVotes) {
    if (votes > bestVotes) {
      bestVotes = votes;
      category = cat;
    }
  }

  const severity =
    keptWeight > 0
      ? Math.round(keptNeighbors.reduce((s, n) => s + n.ex.severity * n.weight, 0) / keptWeight)
      : withDistance.length > 0
        ? withDistance[0].ex.severity
        : 1;

  return { relevant, category, severity, confidence };
}

// Deterministic fold assignment (index % foldCount), not random — same
// "reproducible, not shuffled" discipline as linearRegression.ts's own
// nested-CV split, for the identical reason: a fixed split makes a
// reported accuracy number reproducible across runs, not dependent on
// which random seed happened to be used.
function assignFolds<T>(items: T[], foldCount: number): T[][] {
  const folds: T[][] = Array.from({ length: foldCount }, () => []);
  items.forEach((item, i) => folds[i % foldCount].push(item));
  return folds;
}

// Caps the cross-validation sample so this stays a bounded, predictable
// weekly-batch-job cost regardless of how large classification_archive
// grows over time — the FINAL classifier still uses the full corpus as its
// reference pool for real predictions; only the k-selection step itself is
// capped. Deterministic (every-Nth-index subsample, not random) for the
// same reproducibility reason as assignFolds above.
const MAX_CV_SAMPLE = 1200;
const CV_FOLDS = 3;

function subsampleDeterministic<T>(items: T[], maxSize: number): T[] {
  if (items.length <= maxSize) return items;
  const step = items.length / maxSize;
  const result: T[] = [];
  for (let i = 0; result.length < maxSize && Math.floor(i * step) < items.length; i++) {
    result.push(items[Math.floor(i * step)]);
  }
  return result;
}

export interface KSelectionResult {
  k: number;
  weighting: KnnWeighting;
  accuracy: number; // held-out relevance-prediction accuracy, averaged across CV_FOLDS folds
}

// k-fold cross-validation over the relevance (kept/dropped) task
// specifically — the best-defined, most balanced task this classifier
// handles (unlike category, which is only defined for kept items and
// heavily class-imbalanced — see this session's own live audit of real
// category volumes). Real, data-driven model selection, not a guessed k.
// Selects (k, weighting) JOINTLY: every candidate pair is scored against
// the identical folds, so the comparison between uniform and distance-
// weighted voting is apples to apples. Ties go to the earlier candidate
// (smaller k, uniform first) — the simpler model, when the data can't
// tell them apart.
export function chooseBestK(labeled: LabeledExample[], candidates: number[]): KSelectionResult {
  const sample = subsampleDeterministic(labeled, MAX_CV_SAMPLE);
  const folds = assignFolds(sample, CV_FOLDS);

  const validCandidates = candidates.filter((k) => Number.isInteger(k) && k > 0);
  const metricKey = (k: number, weighting: KnnWeighting) => `${weighting}:${k}`;
  const metrics = new Map<string, { correct: number; total: number }>();
  for (const weighting of KNN_WEIGHTINGS) {
    for (const k of validCandidates) metrics.set(metricKey(k, weighting), { correct: 0, total: 0 });
  }
  // Neighbor ordering is independent of k AND of weighting. Compute
  // distances once per holdout item, then evaluate every (k, weighting)
  // vote against that one sorted order via prefix sums.
  for (let holdout = 0; holdout < CV_FOLDS; holdout++) {
    const testSet = folds[holdout];
    const trainSet = folds.filter((_, i) => i !== holdout).flat();
    for (const item of testSet) {
      const neighbors = trainSet.map((example) => ({ example, distance: cosineDistance(item.embedding, example.embedding) }))
        .sort((a, b) => a.distance - b.distance);
      for (const weighting of KNN_WEIGHTINGS) {
        const keptPrefix = [0];
        const totalPrefix = [0];
        for (const neighbor of neighbors) {
          const w = neighborWeight(neighbor.distance, weighting);
          keptPrefix.push(keptPrefix[keptPrefix.length - 1] + (neighbor.example.kept ? w : 0));
          totalPrefix.push(totalPrefix[totalPrefix.length - 1] + w);
        }
        for (const k of validCandidates) {
          if (trainSet.length < k) continue;
          const metric = metrics.get(metricKey(k, weighting))!;
          if ((keptPrefix[k] > totalPrefix[k] / 2) === item.kept) metric.correct++;
          metric.total++;
        }
      }
    }
  }
  let best: KSelectionResult | null = null;
  for (const weighting of KNN_WEIGHTINGS) {
    for (const k of validCandidates) {
      const metric = metrics.get(metricKey(k, weighting))!;
      if (metric.total === 0) continue;
      const accuracy = metric.correct / metric.total;
      if (!best || accuracy > best.accuracy) best = { k, weighting, accuracy };
    }
  }

  if (!best) throw new Error(`no valid k candidates for ${labeled.length} labeled examples (candidates: ${candidates.join(",")})`);
  return best;
}
