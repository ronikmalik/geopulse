import { getDb } from "@/db";
import { events } from "@/db/schema";
import { desc, isNull, and, eq, sql, getTableColumns } from "drizzle-orm";
import { NOT_KILL_SWITCHED } from "@/lib/killSwitch";

// The live feed, served from Vercel's cache and regenerated only when the
// pipeline says the data changed (2026-09-21). History of this route:
//
//   - Until 2026-09-19 it was an SSE stream (/api/stream) that held a
//     function open per viewer and re-queried the DB every 4s — ~26% of
//     the project's Vercel compute.
//   - 2026-09-19..21 it was a stateless poll with a per-viewer `?since=`
//     cursor. Cheap on Vercel, but every poll from every viewer was its
//     own cache key and so its own DB query — one open tab hit Neon every
//     12s, which on the Free plan's 100 CU-hour month meant the compute
//     could never scale to zero while anyone was looking.
//
// Now: an ISR route handler. No `request` is read (that would make it
// dynamic), so Next serves the stored response for every viewer and only
// regenerates it when (a) REVALIDATE_SECONDS elapse or (b) the runner
// calls POST /api/admin/revalidate after each ingest+review — the only
// moment rows actually become visible. Viewers poll this every ~12s and
// get a cache hit; Neon is read once per pipeline cycle instead of once
// per viewer per poll. The delta/cursor shape is gone: the client
// (useEventStream.ts) reconciles against this full window every poll,
// which it already knew how to do, and toasts what it hasn't seen.
//
// Same rows as before: newest INITIAL_LIMIT approved primaries (cross-
// outlet duplicates hidden — src/lib/eventDedup.ts), ascending id, with
// sourceCount so a card can show "N more sources" without a round-trip.
//
// REVALIDATE_SECONDS is the safety net if the purge ever stops arriving
// (runner down, secret rotated): the feed is then at most this stale,
// which is one pipeline cycle. Under normal operation the purge lands
// first and this timer never fires.
export const revalidate = 900;

const PRIMARY_ONLY = isNull(events.primaryEventId);
const APPROVED_ONLY = eq(events.reviewStatus, "approved");
const withSourceCount = {
  ...getTableColumns(events),
  sourceCount: sql<number>`(select count(*) from ${events} e2 where e2.primary_event_id = ${events.id} and e2.review_status = 'approved' and e2.pre_kill_switch_at is null)`.as(
    "sourceCount",
  ),
};

const INITIAL_LIMIT = 100;

export async function GET() {
  const db = getDb();
  const recent = await db
    .select(withSourceCount)
    .from(events)
    .where(and(PRIMARY_ONLY, APPROVED_ONLY, NOT_KILL_SWITCHED))
    .orderBy(desc(events.id))
    .limit(INITIAL_LIMIT);
  const ordered = recent.reverse();
  const cursor = ordered.length > 0 ? ordered[ordered.length - 1].id : 0;
  return Response.json({ events: ordered, cursor, generatedAt: new Date().toISOString() });
}
