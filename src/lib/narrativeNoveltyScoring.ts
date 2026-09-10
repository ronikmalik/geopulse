import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { feedArchive, narrativeClusters, narrativeNoveltyFindings } from "@/db/schema";
import { cosineDistance, normalize } from "@/lib/narrativeClustering";

// Runs BETWEEN weekly training runs (src/lib/narrativeTraining.ts) — scores
// any feed_archive row that has an embedding but no narrative_novelty_
// findings row yet, against whatever cluster map is CURRENTLY latest (not
// re-fitting anything itself). Pure arithmetic (a handful of dot products
// per row) with no external API calls, so — unlike the Gemini-based
// enrichment passes in ingest.ts — this is safe to run every ingest cycle
// without any rate-limit concern.
const BATCH_SIZE = 50;

export interface NoveltyScoringResult {
  scored: number;
  novel: number;
  skipped: boolean; // true when no cluster map exists yet (training hasn't run) -- rows are left unscored, not marked, so they're retried once one does
}

export async function scoreNewNarrativeItems(): Promise<NoveltyScoringResult> {
  const db = getDb();

  const [maxRow] = await db
    .select({ trainedAt: sql<string>`max(${narrativeClusters.trainedAt})` })
    .from(narrativeClusters);
  if (!maxRow?.trainedAt) return { scored: 0, novel: 0, skipped: true };
  // The raw sql`max(...)` aggregate comes back from the driver as a plain
  // string, NOT a real Date instance — sql<T> is a compile-time type hint
  // only, it doesn't convert anything at runtime. Passing that string
  // straight into a later Drizzle eq() against a real timestamp column
  // crashes inside PgTimestamp's own mapToDriverValue (it calls
  // .toISOString() on whatever it's given) — caught live against
  // production data, not assumed. new Date(...) here is the actual fix.
  const latestTrainedAt = new Date(maxRow.trainedAt);

  const clusters = await db
    .select({
      id: narrativeClusters.id,
      centroid: narrativeClusters.centroid,
      noveltyThreshold: narrativeClusters.noveltyThreshold,
    })
    .from(narrativeClusters)
    .where(eq(narrativeClusters.trainedAt, latestTrainedAt));
  if (clusters.length === 0) return { scored: 0, novel: 0, skipped: true };

  // Centroids from training are already unit-normalized (see
  // narrativeClustering.ts's runKMeans) — re-normalizing here would be a
  // harmless no-op but is skipped since it's genuinely unnecessary, not an
  // assumption: chooseBestK's own contract guarantees it.
  const unscored = await db
    .select({ id: feedArchive.id, embedding: feedArchive.embedding })
    .from(feedArchive)
    .leftJoin(narrativeNoveltyFindings, eq(narrativeNoveltyFindings.feedArchiveId, feedArchive.id))
    .where(and(isNotNull(feedArchive.embedding), isNull(narrativeNoveltyFindings.id)))
    .limit(BATCH_SIZE);

  if (unscored.length === 0) return { scored: 0, novel: 0, skipped: false };

  const detectedAt = new Date();
  const rows = unscored
    .filter((r): r is { id: number; embedding: number[] } => r.embedding !== null)
    .map((r) => {
      const normalized = normalize(r.embedding);
      let bestClusterId = clusters[0].id;
      let bestDistance = Infinity;
      let bestThreshold = clusters[0].noveltyThreshold;
      for (const c of clusters) {
        const d = cosineDistance(normalized, c.centroid);
        if (d < bestDistance) {
          bestDistance = d;
          bestClusterId = c.id;
          bestThreshold = c.noveltyThreshold;
        }
      }
      return {
        feedArchiveId: r.id,
        detectedAt,
        outcome: bestDistance > bestThreshold ? "novel" : "matched-cluster",
        nearestClusterId: bestClusterId,
        distance: bestDistance,
      };
    });

  // onConflictDoNothing: a concurrent ingest cycle or the weekly training
  // run could theoretically score the same row first — same defensive
  // posture as every other insert path in this codebase that isn't
  // wrapped in a transaction (this Neon driver has none anywhere, see
  // anomalyScan.ts's own comment on why).
  const inserted = await db
    .insert(narrativeNoveltyFindings)
    .values(rows)
    .onConflictDoNothing({ target: narrativeNoveltyFindings.feedArchiveId })
    .returning({ outcome: narrativeNoveltyFindings.outcome });

  return {
    scored: inserted.length,
    novel: inserted.filter((r) => r.outcome === "novel").length,
    skipped: false,
  };
}
