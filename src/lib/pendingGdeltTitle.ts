import { asc, inArray, lt } from "drizzle-orm";
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

// Oldest first — same fairness reasoning as getPendingBatch in
// pendingTranslation.ts.
export async function getPendingGdeltTitleBatch(limit: number): Promise<PendingGdeltTitleBatchRow[]> {
  const db = getDb();
  return db
    .select({
      url: pendingGdeltTitle.url,
      resolvedCountry: pendingGdeltTitle.resolvedCountry,
      publishedAt: pendingGdeltTitle.publishedAt,
    })
    .from(pendingGdeltTitle)
    .orderBy(asc(pendingGdeltTitle.discoveredAt))
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
