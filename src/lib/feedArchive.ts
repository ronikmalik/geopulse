import { getDb } from "@/db";
import { feedArchive, type NewFeedArchiveRow } from "@/db/schema";

// Durable, unpruned copy of every item that actually lands in `events` —
// the raw substrate for future ML trend/anomaly work (see the doc
// comment on the feedArchive table in src/db/schema.ts). Called right
// alongside every successful events insert in src/lib/ingest.ts, never
// instead of it — this table's only job is to outlive whatever the live
// feed's own future retention policy becomes. Best-effort, same posture
// as archiveClassifications: must never be able to fail or slow down the
// actual live ingest path.
export async function archiveFeedItems(rows: NewFeedArchiveRow[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    const db = getDb();
    await db.insert(feedArchive).values(rows).onConflictDoNothing({ target: feedArchive.url });
  } catch (err) {
    console.error(`archiveFeedItems failed: ${err}`);
  }
}
