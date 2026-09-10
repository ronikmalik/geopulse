import { isNull, eq, desc } from "drizzle-orm";
import { getDb } from "@/db";
import { classificationArchive } from "@/db/schema";
import { embedBatch } from "./embeddings";

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
const BACKFILL_BATCH_SIZE = 12;
const MAX_INPUT_CHARS = 2000;

export interface ClassificationArchiveBackfillResult {
  processed: number;
  skipped: boolean;
}

export async function backfillClassificationArchiveEmbeddings(): Promise<ClassificationArchiveBackfillResult> {
  try {
    const db = getDb();
    const rows = await db
      .select({ id: classificationArchive.id, title: classificationArchive.title, snippet: classificationArchive.snippet })
      .from(classificationArchive)
      .where(isNull(classificationArchive.embedding))
      .orderBy(desc(classificationArchive.id))
      .limit(BACKFILL_BATCH_SIZE);

    if (rows.length === 0) return { processed: 0, skipped: false };

    const texts = rows.map((r) => `${r.title}\n${r.snippet}`.slice(0, MAX_INPUT_CHARS));
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
