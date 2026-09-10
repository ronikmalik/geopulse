import { and, gte, isNotNull, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { feedArchive, narrativeClusters, narrativeNoveltyFindings } from "@/db/schema";
import { chooseBestK } from "@/lib/narrativeClustering";

// Weekly training entrypoint for Project 1 (narrative clustering). Mirrors
// riskModel.ts's own shadow-mode discipline: a scheduled batch job that
// fully re-fits from scratch each run (see this session's earlier
// reasoning on why periodic full retrain beats online/incremental
// updating at this data-arrival rate — a cluster map doesn't need to
// update faster than the corpus meaningfully changes).
//
// LOOKBACK_DAYS matches risk.ts's own LOOKBACK_DAYS (a local, unexported
// constant there — duplicated here with this cross-reference rather than
// exported for one shared value, matching this codebase's existing
// pattern elsewhere of citing a constant instead of force-exporting
// internal implementation details).
const LOOKBACK_DAYS = 30;

// Candidate cluster counts for chooseBestK's silhouette-score search — a
// deliberately wide range relative to this app's real corpus size (low
// hundreds to low thousands of embedded events) rather than a narrow band
// around a guess, so the choice isn't quietly pre-constrained.
const K_CANDIDATES = [5, 10, 15, 20, 25, 30, 40, 50];

// Below this, don't even attempt a fit — same "is there anything to learn
// from at all" reasoning as riskModel.ts's own MIN_TRAINING_SAMPLE,
// scaled up for clustering specifically: the smallest K_CANDIDATES value
// (5) needs several times that many points to produce clusters that mean
// anything at all.
const MIN_TRAINING_SAMPLE = 30;

// The "still genuinely belongs" boundary within a cluster — the 95th
// percentile of that cluster's own member distances, not the max (a
// single unusual member shouldn't single-handedly set the whole cluster's
// novelty bar) and not the median (too permissive — half of any cluster's
// own real members would then read as "novel" against it).
const NOVELTY_PERCENTILE = 0.95;

interface EmbeddedFeedItem {
  id: number;
  embedding: number[];
}

async function fetchEmbeddedFeedArchive(since: Date): Promise<EmbeddedFeedItem[]> {
  const db = getDb();
  const rows = await db
    .select({ id: feedArchive.id, embedding: feedArchive.embedding })
    .from(feedArchive)
    .where(and(isNotNull(feedArchive.embedding), gte(feedArchive.publishedAt, since)));
  return rows
    .filter((r): r is { id: number; embedding: number[] } => r.embedding !== null)
    .map((r) => ({ id: r.id, embedding: r.embedding }));
}

function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const idx = Math.min(sortedAscending.length - 1, Math.floor(p * (sortedAscending.length - 1)));
  return sortedAscending[idx];
}

export interface NarrativeTrainingResult {
  trained: boolean;
  sampleSize: number;
  k: number;
  silhouetteScore: number;
  clustersInserted: number;
  findingsInserted: number;
  notes: string;
}

export async function trainNarrativeClusters(): Promise<NarrativeTrainingResult> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
  const items = await fetchEmbeddedFeedArchive(since);

  if (items.length < MIN_TRAINING_SAMPLE) {
    return {
      trained: false,
      sampleSize: items.length,
      k: 0,
      silhouetteScore: 0,
      clustersInserted: 0,
      findingsInserted: 0,
      notes: `insufficient data: ${items.length} embedded feed_archive row(s) available (need ${MIN_TRAINING_SAMPLE}+) in the last ${LOOKBACK_DAYS} days.`,
    };
  }

  const vectors = items.map((i) => i.embedding);
  const validCandidates = K_CANDIDATES.filter((k) => k < items.length);
  const result = chooseBestK(vectors, validCandidates);

  // Per-cluster member distances, for the novelty-threshold percentile.
  const distancesByCluster = new Map<number, number[]>();
  for (const a of result.assignments) {
    const list = distancesByCluster.get(a.clusterId) ?? [];
    list.push(a.distance);
    distancesByCluster.set(a.clusterId, list);
  }

  const trainedAt = new Date();
  // Insertion order matches result.centroids' own index order (0..k-1) --
  // clusterRows[i] always corresponds to cluster index i, so the inserted
  // rows' returned ids can be mapped back to cluster indices positionally.
  const clusterRows = result.centroids.map((centroid, clusterIndex) => {
    const distances = (distancesByCluster.get(clusterIndex) ?? []).slice().sort((a, b) => a - b);
    return {
      trainedAt,
      centroid,
      memberCount: distances.length,
      noveltyThreshold: percentile(distances, NOVELTY_PERCENTILE),
    };
  });

  const db = getDb();
  const insertedClusters = await db
    .insert(narrativeClusters)
    .values(clusterRows)
    .returning({ id: narrativeClusters.id });
  const clusterIdByIndex = insertedClusters.map((row) => row.id);

  const findingRows = result.assignments.map((a) => {
    const clusterDbId = clusterIdByIndex[a.clusterId];
    const threshold = clusterRows[a.clusterId].noveltyThreshold;
    return {
      feedArchiveId: items[a.index].id,
      detectedAt: trainedAt,
      outcome: a.distance > threshold ? "novel" : "matched-cluster",
      nearestClusterId: clusterDbId,
      distance: a.distance,
    };
  });

  // onConflictDoNothing on feedArchiveId: a row already scored by a PRIOR
  // training run (still inside this run's own LOOKBACK_DAYS window) keeps
  // its original finding rather than being silently re-scored against a
  // completely different cluster map — see narrativeNoveltyFindings's own
  // doc comment in schema.ts for why that permanence matters.
  let findingsInserted = 0;
  if (findingRows.length > 0) {
    const insertedFindings = await db
      .insert(narrativeNoveltyFindings)
      .values(findingRows)
      .onConflictDoNothing({ target: narrativeNoveltyFindings.feedArchiveId })
      .returning({ id: narrativeNoveltyFindings.id });
    findingsInserted = insertedFindings.length;
  }

  return {
    trained: true,
    sampleSize: items.length,
    k: result.k,
    silhouetteScore: result.silhouetteScore,
    clustersInserted: insertedClusters.length,
    findingsInserted,
    notes: `trained k=${result.k} clusters on ${items.length} embedded items (silhouette ${result.silhouetteScore.toFixed(3)}).`,
  };
}

export async function getLatestNarrativeTrainingSummary(): Promise<{
  trainedAt: string;
  clusterCount: number;
} | null> {
  const db = getDb();
  // Same "sql<T> is a type hint, not a runtime conversion" fix as
  // narrativeNoveltyScoring.ts's identical query — the driver returns a
  // plain string here, not a real Date, so it must be wrapped before use
  // in a later Drizzle eq() against a real timestamp column.
  const [maxRow] = await db
    .select({ trainedAt: sql<string>`max(${narrativeClusters.trainedAt})` })
    .from(narrativeClusters);
  if (!maxRow?.trainedAt) return null;
  const latestTrainedAt = new Date(maxRow.trainedAt);

  const matching = await db
    .select({ id: narrativeClusters.id })
    .from(narrativeClusters)
    .where(eq(narrativeClusters.trainedAt, latestTrainedAt));
  return { trainedAt: latestTrainedAt.toISOString(), clusterCount: matching.length };
}
