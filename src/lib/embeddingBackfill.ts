import { isNull, eq, desc, notInArray, and } from "drizzle-orm";
import { getDb } from "@/db";
import { feedArchive } from "@/db/schema";
import { STRUCTURAL_SOURCES } from "./structuralSources";
import { embedBatch } from "./embeddings";
import { getEmbeddingBudget } from "./aiUsage";
import { splitAttribution } from "./displayText";

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
//
// 12 -> 4 (2026-09-10, live-caught): this file's own 12/cycle plus
// classificationArchiveEmbeddingBackfill.ts's own separate 12/cycle add up
// to 24 embedding calls every ~15min ingest cycle — up to 2,304/day against
// the embedding model's confirmed 1,000 RPD free-tier cap (see embeddings.
// ts's own 2026-09-08 rate-limit-dashboard comment), which a live production
// window showed genuinely exhausted mid-day. This backfill doesn't gate
// what publishes (see the file's own header comment — "no business
// blocking whether an event actually makes it onto the live feed"), so
// it's the correct place to spend less and go slower: 4+4=8/cycle now,
// 768/day max, real margin under the cap, leaving RPD/RPM headroom for the
// paths that DO gate credibility. A bigger backfill delay is an accepted
// tradeoff (2026-09-10 user priority: credibility over speed) — see
// embeddings.ts's own circuit-breaker comment for the other half of this.
//
// 4 -> adaptive, first claim on the budget (2026-09-23, measured). A
// fixed 4 per cycle is a daily ceiling set by the ingest cadence, not by
// the budget: 4 x 96 cycles covered the ~270 new events a day, but when
// ingest went to every 30 minutes on 2026-09-21 the ceiling halved to 192
// and published events began falling ~100 a day behind (267 unembedded on
// 2026-09-23) — while the classifier's training archive, which nobody
// sees, took the rest of the budget adaptively. Published events now take
// what they need from the paced budget first (this runs before the
// training archive in the same chain, see ingest.ts); the archive gets
// what is left. MAX_PER_CYCLE bounds wall-clock: embedBatch paces 4 rows
// per 3s, so 24 rows is ~18s.
const MAX_PER_CYCLE = 24;
const MAX_INPUT_CHARS = 2000;

// What gets embedded for a feed row: its title and summary — except that
// a Telegram post's stored text opens with the channel's attribution
// ("Press TV (Iran state media): ..."), and its title is a truncated copy of
// its summary, so the label was embedded twice. Every post from a channel
// therefore resembled every other post from it, and 93-100% of a Telegram
// post's related events were the same channel (measured 2026-09-24). The
// label is policy for display (docs/TELEGRAM_SOURCES.md), not content, so
// it is stripped here; the card still shows it. Rows embedded before this
// keep their old vectors: re-embedding them would cost roughly a day of the
// 900/day budget, and similarEvents.ts excludes same-channel matches anyway.
export function embeddingText(row: { source: string; title: string; summary: string }): string {
  if (!row.source.startsWith("telegram:")) return `${row.title}\n${row.summary}`;
  return splitAttribution(row.summary, row.source).body;
}

export interface BackfillResult {
  processed: number;
  skipped: boolean;
}

export async function backfillFeedArchiveEmbeddings(): Promise<BackfillResult> {
  try {
    const db = getDb();
    const budget = await getEmbeddingBudget();
    const take = Math.min(MAX_PER_CYCLE, budget.remainingRightNow, budget.remainingToday);
    if (take <= 0) return { processed: 0, skipped: true };
    const rows = await db
      .select({ id: feedArchive.id, source: feedArchive.source, title: feedArchive.title, summary: feedArchive.summary })
      .from(feedArchive)
      // Structural sources are never embedded — see structuralSources.ts.
      .where(and(isNull(feedArchive.embedding), notInArray(feedArchive.source, [...STRUCTURAL_SOURCES])))
      .orderBy(desc(feedArchive.id))
      .limit(take);

    if (rows.length === 0) return { processed: 0, skipped: false };

    const texts = rows.map((r) => embeddingText(r).slice(0, MAX_INPUT_CHARS));
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
