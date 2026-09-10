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
): ClassificationPrediction {
  const withDistance = labeled
    .map((ex) => ({ ex, distance: cosineDistance(queryEmbedding, ex.embedding) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, k);

  const keptCount = withDistance.filter((n) => n.ex.kept).length;
  const relevant = keptCount > withDistance.length / 2;
  const confidence = Math.max(keptCount, withDistance.length - keptCount) / withDistance.length;

  const keptNeighbors = withDistance.filter((n) => n.ex.kept);
  const categoryVotes = new Map<string, number>();
  for (const n of keptNeighbors) {
    if (!n.ex.category) continue;
    categoryVotes.set(n.ex.category, (categoryVotes.get(n.ex.category) ?? 0) + 1);
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
    keptNeighbors.length > 0
      ? Math.round(keptNeighbors.reduce((s, n) => s + n.ex.severity, 0) / keptNeighbors.length)
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
  accuracy: number; // held-out relevance-prediction accuracy, averaged across CV_FOLDS folds
}

// k-fold cross-validation over the relevance (kept/dropped) task
// specifically — the best-defined, most balanced task this classifier
// handles (unlike category, which is only defined for kept items and
// heavily class-imbalanced — see this session's own live audit of real
// category volumes). Real, data-driven model selection, not a guessed k.
export function chooseBestK(labeled: LabeledExample[], candidates: number[]): KSelectionResult {
  const sample = subsampleDeterministic(labeled, MAX_CV_SAMPLE);
  const folds = assignFolds(sample, CV_FOLDS);

  let best: KSelectionResult | null = null;
  for (const k of candidates) {
    let correct = 0;
    let total = 0;
    for (let holdout = 0; holdout < CV_FOLDS; holdout++) {
      const testSet = folds[holdout];
      const trainSet = folds.filter((_, i) => i !== holdout).flat();
      if (trainSet.length < k) continue; // this k isn't even evaluable against this fold's training pool
      for (const item of testSet) {
        const prediction = classifyViaKnn(item.embedding, trainSet, k);
        if (prediction.relevant === item.kept) correct++;
        total++;
      }
    }
    if (total === 0) continue;
    const accuracy = correct / total;
    if (!best || accuracy > best.accuracy) best = { k, accuracy };
  }

  if (!best) throw new Error(`no valid k candidates for ${labeled.length} labeled examples (candidates: ${candidates.join(",")})`);
  return best;
}
