import { desc, inArray, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { pendingGdeltTitle, type NewPendingGdeltTitleRow } from "@/db/schema";

// Same "don't hold onto it forever" reasoning as PENDING_TRANSLATION_MAX_AGE_MS
// in pendingTranslation.ts — a GDELT candidate whose real title still
// couldn't be fetched after this long (dead link, persistently blocked,
// paywalled) is no longer meaningfully "live breaking" even if a title
// eventually became fetchable; dropped rather than retried indefinitely.
export const PENDING_GDELT_TITLE_MAX_AGE_MS = 24 * 60 * 60_000;

export async function enqueuePendingGdeltTitles(
  rows: NewPendingGdeltTitleRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  await db.insert(pendingGdeltTitle).values(rows).onConflictDoNothing({ target: pendingGdeltTitle.url });
}

export interface PendingGdeltTitleBatchRow {
  url: string;
  resolvedCountry: string;
  publishedAt: Date;
}

// Newest first (2026-09-11, changed from oldest-first) — this queue's
// purpose ("live breaking news") is at odds with strict FIFO fairness once
// a real backlog builds up: at up to DRAIN_BATCH_SIZE candidates drained
// per ~15min ingest cycle (see gdeltBulk.ts), a multi-thousand-row backlog
// takes many cycles to clear, and under oldest-first every one of those
// cycles spent its whole batch on old rows before a single freshly-
// discovered candidate ever got a title-fetch attempt — production
// measured on 2026-09-11 showed literally zero GDELT items published in
// the last 3 hours reaching the live feed while a ~2,900-row backlog sat
// ahead of them. Newest-first inverts the priority: a breaking-news
// candidate discovered this cycle competes for a slot before anything
// still sitting in the backlog, so it normally clears within ~1 cycle
// regardless of backlog size. The backlog still drains — whatever batch
// capacity isn't claimed by newly-discovered rows goes to the oldest
// remaining backlog rows (this same ORDER BY, just reached only after the
// newest rows are taken) — just no longer at the cost of blocking live
// coverage. The tradeoff: a row that's been waiting a long time is now
// also the most likely to hit expireStalePendingGdeltTitles' 24h cutoff
// before ever getting a title-fetch attempt, rather than the least
// likely — an accepted cost of prioritizing "is this actually live" over
// "will every candidate eventually be attempted."
export async function getPendingGdeltTitleBatch(limit: number): Promise<PendingGdeltTitleBatchRow[]> {
  const db = getDb();
  return db
    .select({
      url: pendingGdeltTitle.url,
      resolvedCountry: pendingGdeltTitle.resolvedCountry,
      publishedAt: pendingGdeltTitle.publishedAt,
    })
    .from(pendingGdeltTitle)
    .orderBy(desc(pendingGdeltTitle.discoveredAt))
    .limit(limit);
}

export async function deletePendingGdeltTitles(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  const db = getDb();
  await db.delete(pendingGdeltTitle).where(inArray(pendingGdeltTitle.url, urls));
}

export async function expireStalePendingGdeltTitles(): Promise<void> {
  const db = getDb();
  const cutoff = new Date(Date.now() - PENDING_GDELT_TITLE_MAX_AGE_MS);
  await db.delete(pendingGdeltTitle).where(lt(pendingGdeltTitle.discoveredAt, cutoff));
}
