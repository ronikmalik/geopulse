import { isNull, eq, desc } from "drizzle-orm";
import { getDb } from "@/db";
import { feedArchive } from "@/db/schema";
import { embedBatch, MAX_BATCH_SIZE } from "./embeddings";

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
const BACKFILL_BATCH_SIZE = MAX_BATCH_SIZE;
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

    // No bulk vector UPDATE across a small in-memory list worth building
    // raw SQL for — one UPDATE per row, same as any other per-row
    // enrichment pass in this codebase (see recordSourceHealth).
    for (let i = 0; i < rows.length; i++) {
      await db
        .update(feedArchive)
        .set({ embedding: embeddings[i] })
        .where(eq(feedArchive.id, rows[i].id));
    }

    return { processed: rows.length, skipped: false };
  } catch (err) {
    console.error(`backfillFeedArchiveEmbeddings failed: ${err}`);
    return { processed: 0, skipped: true };
  }
}
