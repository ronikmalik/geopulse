import { isNull, eq, desc } from "drizzle-orm";
import { getDb } from "@/db";
import { feedArchive } from "@/db/schema";
import { embedBatch } from "./embeddings";

// Deliberately decoupled from the insert path (src/lib/feedArchive.ts's
// archiveFeedItems) rather than embedding inline at insert time — ingest
// already has a tight per-cycle time budget (see the withDeadline
// wrapping in src/lib/ingest.ts), and an embedding call is one more
// network round-trip that has no business blocking whether an event
// actually makes it onto the live feed. Same "catch up later, never
// gate on it" posture as drainPendingTelegramTranslations. Called once
// per ingest cycle, best-effort — see the call site in runIngest.
//
// Newest-first (id desc): the live feed's "similar events" feature (GET
// /api/events/[id]/similar) is most valuable on events that are still
// actually showing on the feed, so a backlog — which shouldn't happen at
// this app's volume, but if it ever does — degrades by leaving old rows
// unembedded rather than leaving today's news unembedded.
//
// Sized for embedBatch's individual-call-per-text reality (see
// embeddings.ts — there is no synchronous batch endpoint for this model
// generation), not an arbitrary API batch limit. embeddings.ts's
// CONCURRENCY (4) and CHUNK_SPACING_MS (3s, added 2026-09-08 to fix real
// RPM 429s) mean 12 items is 3 chunks — 2 gaps of 3s plus request time —
// comfortably inside runIngest's 8s deadline for this step. A run that
// still doesn't finish in time is fine either way (withDeadline races
// rather than blocks — see the doc comment on the call site in
// ingest.ts), this sizing just keeps that the exception, not routine.
const BACKFILL_BATCH_SIZE = 12;
const MAX_INPUT_CHARS = 2000;

export interface BackfillResult {
  processed: number;
  skipped: boolean;
}

export async function backfillFeedArchiveEmbeddings(): Promise<BackfillResult> {
  try {
    const db = getDb();
    const rows = await db
      .select({ id: feedArchive.id, title: feedArchive.title, summary: feedArchive.summary })
      .from(feedArchive)
      .where(isNull(feedArchive.embedding))
      .orderBy(desc(feedArchive.id))
      .limit(BACKFILL_BATCH_SIZE);

    if (rows.length === 0) return { processed: 0, skipped: false };

    const texts = rows.map((r) => `${r.title}\n${r.summary}`.slice(0, MAX_INPUT_CHARS));
    const embeddings = await embedBatch(texts);
    if (!embeddings) return { processed: 0, skipped: true };

    // Per-item nulls are expected now (one bad text shouldn't waste the
    // rest of the batch — see embedBatch's doc comment) — only rows that
    // actually got a real embedding get updated; the rest stay NULL and
    // are retried on a future cycle. No bulk vector UPDATE across a small
    // in-memory list worth building raw SQL for — one UPDATE per row,
    // same as any other per-row enrichment pass in this codebase (see
    // recordSourceHealth).
    let processed = 0;
    for (let i = 0; i < rows.length; i++) {
      if (!embeddings[i]) continue;
      await db
        .update(feedArchive)
        .set({ embedding: embeddings[i]! })
        .where(eq(feedArchive.id, rows[i].id));
      processed++;
    }

    return { processed, skipped: false };
  } catch (err) {
    console.error(`backfillFeedArchiveEmbeddings failed: ${err}`);
    return { processed: 0, skipped: true };
  }
}
