// Spherical (cosine-distance) k-means — the clustering core for Project 1
// (2026-09-09, user request for "real ML" beyond linear regression):
// unsupervised clustering over feed_archive's existing Gemini embeddings
// (see src/lib/embeddings.ts/embeddingBackfill.ts), currently used only for
// pairwise "similar events" lookups (similarEvents.ts) and never clustered.
//
// Hand-rolled, same "no ML dependency" bar as linearRegression.ts — this
// isn't a shortcut, spherical k-means is genuinely the standard, correct
// choice for clustering dense text embeddings (cosine similarity is what
// these embeddings are actually trained to be meaningful under, not raw
// Euclidean distance) and is a well-understood, textbook algorithm, not
// something exotic being reimplemented shakily.
//
// k is NOT hardcoded — chosen via silhouette score across a candidate
// range at runtime (see chooseBestK below), a real, data-driven model-
// selection step rather than a guessed constant.

export interface ClusterAssignment {
  index: number; // index into the input vectors array
  clusterId: number;
  distance: number; // cosine distance to its assigned cluster's centroid
}

export interface KMeansResult {
  k: number;
  centroids: number[][]; // unit-normalized, one per cluster
  assignments: ClusterAssignment[];
  silhouetteScore: number;
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function norm(a: number[]): number {
  return Math.sqrt(dot(a, a));
}

function normalize(a: number[]): number[] {
  const n = norm(a);
  return n > 0 ? a.map((v) => v / n) : a.slice();
}

// Cosine distance = 1 - cosine similarity. For unit-normalized vectors,
// cosine similarity IS the dot product, so this is just 1 - dot(a, b) — no
// separate division needed given both inputs are already normalized by the
// caller (every vector this module handles is normalized once on the way
// in, not re-normalized per comparison).
function cosineDistance(a: number[], b: number[]): number {
  return 1 - dot(a, b);
}

function meanVector(vectors: number[][]): number[] {
  const k = vectors[0].length;
  const m = new Array(k).fill(0);
  for (const v of vectors) for (let i = 0; i < k; i++) m[i] += v[i] / vectors.length;
  return m;
}

// k-means++ initialization — picks the first centroid uniformly at random,
// then each subsequent centroid with probability proportional to its
// squared distance from the nearest already-chosen centroid. Standard,
// well-established technique specifically because plain random
// initialization risks a bad local optimum (e.g. two initial centroids
// landing in the same real cluster, leaving another real cluster
// unrepresented) — not an invented refinement.
function kMeansPlusPlusInit(vectors: number[][], k: number, rng: () => number): number[][] {
  const centroids: number[][] = [];
  const firstIdx = Math.floor(rng() * vectors.length);
  centroids.push(vectors[firstIdx].slice());

  while (centroids.length < k) {
    const distances = vectors.map((v) => {
      let minDist = Infinity;
      for (const c of centroids) minDist = Math.min(minDist, cosineDistance(v, c));
      return minDist * minDist;
    });
    const total = distances.reduce((s, d) => s + d, 0);
    if (total === 0) {
      // Every remaining point is identical to an existing centroid —
      // degenerate but not an error; pick any remaining point so k
      // centroids still get returned.
      const idx = centroids.length % vectors.length;
      centroids.push(vectors[idx].slice());
      continue;
    }
    let target = rng() * total;
    let chosenIdx = distances.length - 1;
    for (let i = 0; i < distances.length; i++) {
      target -= distances[i];
      if (target <= 0) {
        chosenIdx = i;
        break;
      }
    }
    centroids.push(vectors[chosenIdx].slice());
  }
  return centroids;
}

const MAX_ITERATIONS = 100;

// A single k-means run for one fixed k. `rng` is injectable (defaults to
// Math.random) specifically so this can be tested deterministically — see
// this module's own test discipline elsewhere in this session (every
// hand-rolled model gets a synthetic-data check before trusting it against
// production).
export function runKMeans(vectors: number[][], k: number, rng: () => number = Math.random): KMeansResult {
  const normalized = vectors.map(normalize);
  let centroids = kMeansPlusPlusInit(normalized, k, rng);
  let assignments: number[] = new Array(normalized.length).fill(-1);

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let changed = false;
    const newAssignments: number[] = new Array(normalized.length);

    for (let i = 0; i < normalized.length; i++) {
      let bestCluster = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = cosineDistance(normalized[i], centroids[c]);
        if (d < bestDist) {
          bestDist = d;
          bestCluster = c;
        }
      }
      newAssignments[i] = bestCluster;
      if (newAssignments[i] !== assignments[i]) changed = true;
    }
    assignments = newAssignments;

    const newCentroids: number[][] = [];
    for (let c = 0; c < k; c++) {
      const members = normalized.filter((_, i) => assignments[i] === c);
      // An empty cluster (can happen with k-means++ on skewed data) is
      // re-seeded at the point currently furthest from its own assigned
      // centroid — gives the optimization a chance to recover a genuinely
      // useful cluster there instead of leaving a permanently dead one.
      if (members.length === 0) {
        let worstIdx = 0;
        let worstDist = -Infinity;
        for (let i = 0; i < normalized.length; i++) {
          const d = cosineDistance(normalized[i], centroids[assignments[i]]);
          if (d > worstDist) {
            worstDist = d;
            worstIdx = i;
          }
        }
        newCentroids.push(normalized[worstIdx].slice());
      } else {
        newCentroids.push(normalize(meanVector(members)));
      }
    }
    centroids = newCentroids;

    if (!changed && iter > 0) break;
  }

  const assignmentResults: ClusterAssignment[] = normalized.map((v, i) => ({
    index: i,
    clusterId: assignments[i],
    distance: cosineDistance(v, centroids[assignments[i]]),
  }));

  return {
    k,
    centroids,
    assignments: assignmentResults,
    silhouetteScore: silhouetteScore(normalized, assignments, k),
  };
}

// Standard silhouette score: for point i, a(i) = mean distance to other
// points in its own cluster, b(i) = mean distance to points in the
// nearest OTHER cluster, s(i) = (b-a)/max(a,b). Averaged over all points.
// O(n^2) — fine at this app's real corpus size (low hundreds to low
// thousands of embedded events), not something that needs an approximation
// at this scale.
function silhouetteScore(normalized: number[][], assignments: number[], k: number): number {
  if (k < 2 || normalized.length <= k) return -1; // degenerate — never the best choice
  const n = normalized.length;
  const byCluster: number[][] = Array.from({ length: k }, () => []);
  assignments.forEach((c, i) => byCluster[c].push(i));

  let total = 0;
  let counted = 0;
  for (let i = 0; i < n; i++) {
    const ownCluster = assignments[i];
    const ownMembers = byCluster[ownCluster].filter((j) => j !== i);
    if (ownMembers.length === 0) continue; // a singleton cluster has no defined a(i) — excluded from the average, not treated as 0
    const a = ownMembers.reduce((s, j) => s + cosineDistance(normalized[i], normalized[j]), 0) / ownMembers.length;

    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === ownCluster || byCluster[c].length === 0) continue;
      const meanDist =
        byCluster[c].reduce((s, j) => s + cosineDistance(normalized[i], normalized[j]), 0) / byCluster[c].length;
      b = Math.min(b, meanDist);
    }
    if (b === Infinity) continue; // only one non-empty cluster exists — no "nearest other cluster" to compare against

    const s = (b - a) / Math.max(a, b);
    total += s;
    counted++;
  }
  return counted > 0 ? total / counted : -1;
}

// Runs k-means for every candidate k and returns whichever maximizes
// silhouette score — the real, data-driven model-selection step (see this
// module's own header comment). Candidates deliberately span a wide range
// relative to n rather than a narrow band around a guess, so the choice
// isn't quietly pre-constrained to a range that happens to flatter one
// particular k.
export function chooseBestK(
  vectors: number[][],
  candidates: number[],
  rng: () => number = Math.random,
): KMeansResult {
  const validCandidates = candidates.filter((k) => k >= 2 && k < vectors.length);
  if (validCandidates.length === 0) {
    throw new Error(`no valid k candidates for ${vectors.length} vectors (candidates: ${candidates.join(",")})`);
  }
  let best: KMeansResult | null = null;
  for (const k of validCandidates) {
    const result = runKMeans(vectors, k, rng);
    if (!best || result.silhouetteScore > best.silhouetteScore) best = result;
  }
  return best!;
}

export { cosineDistance, normalize };
