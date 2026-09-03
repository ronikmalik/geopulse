import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { sourceHealth, type SourceHealthRow } from "@/db/schema";

export interface TrackedFetch<T> {
  source: string;
  items: T[];
  latencyMs: number;
  error: string | null;
}

// Wraps a source fetch with timing + success/failure capture, without
// changing its error-handling contract — the caller still gets an empty
// array on failure, exactly like the bare .catch() pattern it replaces.
export async function trackFetch<T>(
  source: string,
  fn: () => Promise<T[]>,
): Promise<TrackedFetch<T>> {
  const start = Date.now();
  try {
    const items = await fn();
    return { source, items, latencyMs: Date.now() - start, error: null };
  } catch (err) {
    return { source, items: [], latencyMs: Date.now() - start, error: String(err) };
  }
}

// Structurally matches TrackedFetch<T> for any T (array covariance makes
// e.g. TrackedFetch<RawItem> assignable here with no cast) — callers pass
// a mix of TrackedFetch<RawItem> and TrackedFetch<DirectItem> results in
// one array, and only the common fields (source/error/items.length) are
// ever read, so the specific element type genuinely doesn't matter here.
interface SourceFetchOutcome {
  source: string;
  items: unknown[];
  latencyMs: number;
  error: string | null;
}

// Upserts one row per source. lastSuccessAt/lastItemCount/lastError(At)
// only move forward on the dimension this run actually has news about —
// a failed run doesn't erase the last known-good state, and a successful
// run doesn't erase the memory of the last failure. That's what makes
// "is this source currently healthy" a comparison of lastAttemptAt vs.
// lastSuccessAt, not something that needs its own boolean column.
export async function recordSourceHealth(
  results: SourceFetchOutcome[],
): Promise<void> {
  if (results.length === 0) return;
  const db = getDb();
  const now = new Date();

  const rows = results.map((r) => ({
    source: r.source,
    lastAttemptAt: now,
    lastSuccessAt: r.error ? null : now,
    lastItemCount: r.error ? null : r.items.length,
    lastLatencyMs: r.latencyMs,
    lastError: r.error,
    lastErrorAt: r.error ? now : null,
  }));

  try {
    await db
      .insert(sourceHealth)
      .values(rows)
      .onConflictDoUpdate({
        target: sourceHealth.source,
        set: {
          lastAttemptAt: sql`excluded.last_attempt_at`,
          lastSuccessAt: sql`coalesce(excluded.last_success_at, ${sourceHealth.lastSuccessAt})`,
          lastItemCount: sql`coalesce(excluded.last_item_count, ${sourceHealth.lastItemCount})`,
          lastLatencyMs: sql`excluded.last_latency_ms`,
          lastError: sql`coalesce(excluded.last_error, ${sourceHealth.lastError})`,
          lastErrorAt: sql`coalesce(excluded.last_error_at, ${sourceHealth.lastErrorAt})`,
        },
      });
  } catch (err) {
    // Health tracking is best-effort — never let it take down ingestion.
    console.error(`recordSourceHealth failed: ${err}`);
  }
}

export async function getSourceHealth(): Promise<SourceHealthRow[]> {
  const db = getDb();
  return db.select().from(sourceHealth).orderBy(sourceHealth.source);
}
