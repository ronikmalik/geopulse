import { isNull, isNotNull, eq, desc, and, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { classificationArchive } from "@/db/schema";
import { embedBatch } from "./embeddings";
import { getEmbeddingBudget } from "./aiUsage";

// Project 3's own embedding backfill for classification_archive — separate
// from embeddingBackfill.ts (feed_archive) because feed_archive only ever
// holds KEPT items; the ~2:1 majority of classification_archive (kept =
// false, the negative-label pool a relevance classifier needs) has no
// embedding anywhere else. Same batch-size/newest-first reasoning as
// embeddingBackfill.ts's own doc comment — see that file for the full
// argument; not repeated here since it applies identically.
//
// IMPORTANT: this shares the same underlying Gemini embedding model/rate
// limit as embeddingBackfill.ts (see embeddings.ts's own 100 RPM ceiling
// comment) — the two must never run concurrently from the same ingest
// cycle, only sequentially (see ingest.ts's own call site), the same
// "never more than one caller of a rate-limited API in flight at once"
// discipline already applied to the Gemini text-audit chain after real
// production 429s.
// 12 -> 4 (2026-09-10, live-caught) -> adaptive (2026-09-20). The fixed 4
// was sized for Vercel's 55s function clock and the shared 1,000 RPD cap.
// Neither applies the same way now: this runs on a GitHub Actions runner
// with no clock (see scripts/run-job.ts), and the daily cap is enforced by
// aiUsage.ts's intra-day fair share (getEmbeddingBudget). So each cycle
// takes whatever that fair share currently allows, up to MAX_PER_CYCLE —
// which is what actually spends the whole 900/day instead of leaving the
// last ~10% unspent behind a fixed per-cycle number, and lets a quiet
// hour's unspent share roll forward instead of evaporating. embedBatch
// is all-or-nothing on budget (asks for N, embeds nothing if N isn't
// affordable), so the request is sized to the budget FIRST, never the
// other way round. feed_archive's backfill (the live "similar events"
// feature) runs before this one in ingest.ts and takes its share of the
// same paced budget first (since 2026-09-23), so this one gets what is left.
//
// MAX_PER_CYCLE bounds wall-clock (embedBatch paces 4 rows per 3s, so 40
// rows is ~30s) and keeps well inside ingest.ts's deadline for this step.
const MAX_PER_CYCLE = 40;
const MAX_INPUT_CHARS = 2000;

// Dropped rows are embedded only while the embedded negative pool is below
// this multiple of the embedded kept pool (2026-09-23). Measured that day:
// ~340 kept and ~1,250 dropped rows archived a day, against ~630 embedding
// calls a day left once published events are served. Kept rows fit in
// that; dropped rows never can, so "embed everything" was a backlog
// that could only grow (20,920 rows and rising). A nearest-neighbour
// classifier gains little from negatives beyond a small multiple of its
// positives (chooseBestK already subsamples to 1,200 for cross-validation),
// so past this ratio an unembedded dropped row is a decision, not a debt —
// and the only backlog that has to reach zero is the kept one.
const MAX_DROPPED_PER_KEPT = 2;

export interface ClassificationArchiveBackfillResult {
  processed: number;
  skipped: boolean;
}

export async function backfillClassificationArchiveEmbeddings(): Promise<ClassificationArchiveBackfillResult> {
  try {
    const db = getDb();
    const budget = await getEmbeddingBudget();
    const take = Math.min(MAX_PER_CYCLE, budget.remainingRightNow, budget.remainingToday);
    if (take <= 0) return { processed: 0, skipped: true };

    // Priority (2026-09-20): kept rows first, then dropped, newest first
    // within each. The k-NN classifier's minority class is kept=true (the
    // archive is ~3:1 dropped), so every kept row embedded improves the
    // reference pool where it is weakest; the ~14k dropped rows are far
    // more negatives than a k-NN needs (chooseBestK subsamples to 1,200
    // for CV anyway), so they take the remainder rather than the lead.
    const [pool] = await db
      .select({
        kept: sql<number>`count(*) filter (where ${classificationArchive.kept})::int`,
        dropped: sql<number>`count(*) filter (where not ${classificationArchive.kept})::int`,
      })
      .from(classificationArchive)
      .where(isNotNull(classificationArchive.embedding));
    const wantDropped = (pool?.dropped ?? 0) < MAX_DROPPED_PER_KEPT * (pool?.kept ?? 0);
    const rows = await db
      .select({ id: classificationArchive.id, title: classificationArchive.title, snippet: classificationArchive.snippet })
      .from(classificationArchive)
      .where(
        wantDropped
          ? isNull(classificationArchive.embedding)
          : and(isNull(classificationArchive.embedding), eq(classificationArchive.kept, true)),
      )
      .orderBy(desc(classificationArchive.kept), desc(classificationArchive.id))
      .limit(take);

    if (rows.length === 0) return { processed: 0, skipped: false };

    const texts = rows.map((r) => `${r.title}
${r.snippet}`.slice(0, MAX_INPUT_CHARS));
    const embeddings = await embedBatch(texts);
    if (!embeddings) return { processed: 0, skipped: true };

    let processed = 0;
    for (let i = 0; i < rows.length; i++) {
      if (!embeddings[i]) continue;
      await db
        .update(classificationArchive)
        .set({ embedding: embeddings[i]! })
        .where(eq(classificationArchive.id, rows[i].id));
      processed++;
    }

    return { processed, skipped: false };
  } catch (err) {
    console.error(`backfillClassificationArchiveEmbeddings failed: ${err}`);
    return { processed: 0, skipped: true };
  }
}
