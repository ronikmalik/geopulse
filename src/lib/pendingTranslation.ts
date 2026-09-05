import { asc, inArray, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { pendingTranslation, type NewPendingTranslationRow } from "@/db/schema";

// How long a post can sit waiting for translation budget (or a recovering
// Translate API) before it's no longer meaningfully "live breaking" —
// dropped unprocessed past this rather than kept forever, since an
// ever-growing backlog would eventually just be translating old news.
// See src/lib/sources/telegram.ts.
export const PENDING_TRANSLATION_MAX_AGE_MS = 48 * 60 * 60_000;

export async function enqueuePendingTranslations(
  rows: NewPendingTranslationRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  await db
    .insert(pendingTranslation)
    .values(rows)
    .onConflictDoNothing({ target: pendingTranslation.url });
}

export interface PendingBatchRow {
  url: string;
  handle: string;
  excerpt: string;
  publishedAt: Date;
}

// Oldest first — a post that's been waiting longest is closest to
// PENDING_TRANSLATION_MAX_AGE_MS, so it gets first claim on whatever
// budget this cycle has.
export async function getPendingBatch(limit: number): Promise<PendingBatchRow[]> {
  const db = getDb();
  return db
    .select({
      url: pendingTranslation.url,
      handle: pendingTranslation.handle,
      excerpt: pendingTranslation.excerpt,
      publishedAt: pendingTranslation.publishedAt,
    })
    .from(pendingTranslation)
    .orderBy(asc(pendingTranslation.discoveredAt))
    .limit(limit);
}

export async function deletePending(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  const db = getDb();
  await db.delete(pendingTranslation).where(inArray(pendingTranslation.url, urls));
}

// Called once per drain pass, before attempting to translate what's left
// — silently drops anything too stale to still count as breaking news
// rather than spending budget translating it.
export async function expireStalePending(): Promise<void> {
  const db = getDb();
  const cutoff = new Date(Date.now() - PENDING_TRANSLATION_MAX_AGE_MS);
  await db.delete(pendingTranslation).where(lt(pendingTranslation.discoveredAt, cutoff));
}
