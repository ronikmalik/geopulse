import { inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { classificationArchive } from "@/db/schema";

export interface ClassificationOutcome {
  source: string;
  url: string;
  title: string;
  snippet: string;
  kept: boolean;
  severity: number;
  category: string | null;
  publishedAt: Date;
  // Shadow-mode native-language classifier's opinion (see
  // src/lib/nativeIncidentClassifier.ts) — only ever set by
  // src/lib/sources/telegram.ts for a non-English row where a real
  // (translated) decision was also made this same row. Omitted entirely
  // (not just false/null) by every other caller (GDELT/RSS), which has no
  // native-language shadow classifier to run.
  nativeKept?: boolean | null;
  nativeSeverity?: number | null;
}

// Best-effort, fire-and-forget from the caller's perspective — archiving
// must never be able to fail or slow down the actual live ingest path.
// Same onConflictDoNothing(url) dedup pattern as events/insertDirectItems:
// the same RSS item reappearing across ingest cycles (it's still in the
// feed's rolling window) shouldn't create duplicate archive rows.
export async function archiveClassifications(
  outcomes: ClassificationOutcome[],
): Promise<void> {
  if (outcomes.length === 0) return;
  try {
    const db = getDb();
    await db
      .insert(classificationArchive)
      .values(outcomes)
      .onConflictDoNothing({ target: classificationArchive.url });
  } catch (err) {
    console.error(`archiveClassifications failed: ${err}`);
  }
}

// Batch existence check against a set of URLs, run before spending any
// translation budget on them — a post already archived here (kept or
// dropped) was already fully scored in a prior cycle, so re-translating
// it a second time (e.g. because two independent schedulers both hit
// /api/ingest within the same 15-minute Telegram rotation window, see
// docs/ARCHITECTURE.md) would burn real quota for zero new signal. See
// src/lib/sources/telegram.ts.
export async function getArchivedUrls(urls: string[]): Promise<Set<string>> {
  if (urls.length === 0) return new Set();
  const db = getDb();
  const rows = await db
    .select({ url: classificationArchive.url })
    .from(classificationArchive)
    .where(inArray(classificationArchive.url, urls));
  return new Set(rows.map((r) => r.url));
}
