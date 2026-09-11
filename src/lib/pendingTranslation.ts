import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { pendingTranslation, type NewPendingTranslationRow } from "@/db/schema";

// A non-English Telegram post that couldn't be translated the cycle it was
// discovered — today's budget was already spent, or the Translate API call
// itself failed. Parked here and left alone (2026-09-10, user request:
// stop spending the day's budget re-translating backlog — a post either
// gets translated the cycle it's discovered, using that day's live
// budget, or it doesn't, full stop). No automatic drain and, as of the
// same request, no time-based expiry either — this used to auto-delete
// anything older than 48h, but the user wants everything kept until they
// decide what to do with it, NOT silently lost on a timer. The only
// removal path left is removeAlreadyResolvedPending below.
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

// A queued post can still end up translated some other way — Telegram's
// web preview keeps re-showing a channel's last ~20 posts on every fetch,
// so a later ingest cycle's own live-fetch path (not this queue) can
// independently re-encounter and successfully translate the same post,
// landing it in classification_archive with a real decision. Once that's
// happened, the queued copy here is pure duplication of data that already
// has a home, so it's safe (and the only thing left) to remove it — see
// enqueuePendingTranslations's own comment for why nothing else deletes
// from this table anymore. An indexed EXISTS check against
// classification_archive.url (already unique/indexed) rather than pulling
// rows into the app to compare, so this stays cheap regardless of how
// large either table grows.
export async function removeAlreadyResolvedPending(): Promise<number> {
  const db = getDb();
  const result = await db.execute(sql`
    DELETE FROM pending_translation
    WHERE EXISTS (
      SELECT 1 FROM classification_archive
      WHERE classification_archive.url = pending_translation.url
    )
  `);
  return result.rowCount ?? 0;
}
