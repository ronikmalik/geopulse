import { NextRequest } from "next/server";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { desc, gt, isNull, and, eq, sql, getTableColumns } from "drizzle-orm";
import { NOT_KILL_SWITCHED } from "@/lib/killSwitch";
import { badRequest, cachedJson } from "@/lib/apiParams";

// The live feed, as a stateless poll (2026-09-19) — replaces the old
// Server-Sent-Events /api/stream route. That route held one serverless
// function open for ~45s per viewer and re-queried the DB every 4s inside
// it; on Vercel Hobby's Fluid compute that was ~26% of the whole project's
// Active CPU and the dominant share of Provisioned Memory (a long-lived
// function pins its instance for its entire wall-clock life). One tab
// left open all day cost more than every scheduled job combined. This
// route does the same work as ONE iteration of that loop, returns, and
// the client (useEventStream.ts) calls it again every ~12s — ~40ms of CPU
// per call and nothing at all while nobody is watching.
//
// Two request shapes:
//   GET /api/events/feed            -> the recent window (INITIAL_LIMIT
//                                      newest approved primaries, ascending
//                                      id) + a cursor. Used on first load
//                                      and for the client's periodic
//                                      reconcile (which is how later
//                                      approvals, corrections and kill-
//                                      switch removals reach an open tab —
//                                      an insertion-id cursor alone can't
//                                      represent any of those).
//   GET /api/events/feed?since=N    -> new approved primaries with id > N,
//                                      ascending, + the advanced cursor.
//
// Cross-outlet duplicates (src/lib/eventDedup.ts) are hidden — only
// primaries (primaryEventId IS NULL) are served. sourceCount tells the
// client whether to show a "N more sources" affordance without a round-
// trip per card. Only events that cleared Gemini's pre-publish review
// (reviewStatus = approved) are ever served — see reviewStatus's doc
// comment in schema.ts.
const PRIMARY_ONLY = isNull(events.primaryEventId);
const APPROVED_ONLY = eq(events.reviewStatus, "approved");
const withSourceCount = {
  ...getTableColumns(events),
  sourceCount: sql<number>`(select count(*) from ${events} e2 where e2.primary_event_id = ${events.id} and e2.review_status = 'approved' and e2.pre_kill_switch_at is null)`.as(
    "sourceCount",
  ),
};

const INITIAL_LIMIT = 100;
const DELTA_LIMIT = 50;

export async function GET(req: NextRequest) {
  const db = getDb();
  const sinceParam = req.nextUrl.searchParams.get("since");

  if (!sinceParam) {
    const recent = await db
      .select(withSourceCount)
      .from(events)
      .where(and(PRIMARY_ONLY, APPROVED_ONLY, NOT_KILL_SWITCHED))
      .orderBy(desc(events.id))
      .limit(INITIAL_LIMIT);
    const ordered = recent.reverse();
    const cursor = ordered.length > 0 ? ordered[ordered.length - 1].id : 0;
    // 10s at the CDN: every tab that loads within the same 10s window
    // shares one function invocation, and a viewer who reloads sees at
    // most 10s of staleness — the poll loop catches up right after.
    return cachedJson({ events: ordered, cursor, reconcile: true }, 10, 20);
  }

  if (!/^\d{1,15}$/.test(sinceParam)) return badRequest("since must be a non-negative integer");
  const since = Number(sinceParam);
  if (!Number.isSafeInteger(since)) return badRequest("since must be a non-negative integer");

  // Deliberately NOT filtered to approved-only in the query itself — a
  // naive `gt(id, since) AND approved` filter has a real gap: if row 105
  // is still pending when row 106 (already approved) gets returned, the
  // cursor advances to 106 and a later gt(id, 106) query can never see
  // row 105 again even once it's promoted — permanently skipping it. So
  // the cursor only advances through a CONTIGUOUS prefix of resolved
  // (approved-and-returned, or rejected) rows; a still-pending row halts
  // the advance and gets re-checked on every poll until it resolves
  // (bounded by PENDING_REVIEW_MAX_AGE_MINUTES for every source but
  // gdelt — see classifierAudit.ts). Rows past the halt point are held
  // back too, so what the client receives is always strictly ascending
  // and chronological, never an older toast arriving after a newer one.
  const candidates = await db
    .select(withSourceCount)
    .from(events)
    .where(and(gt(events.id, since), PRIMARY_ONLY, NOT_KILL_SWITCHED))
    .orderBy(events.id)
    .limit(DELTA_LIMIT);

  const fresh: typeof candidates = [];
  let cursor = since;
  for (const row of candidates) {
    if (row.reviewStatus === "pending") {
      // gdelt is exempt from the halt: classifierAudit.ts's safety net
      // never auto-promotes stale gdelt rows (deliberate, uncapped delay
      // for that one source), so a single stuck gdelt row would otherwise
      // stall live delivery for every other source forever. Skip past it
      // like a rejected row — the client's periodic reconcile still picks
      // it up if it's approved later.
      if (row.source === "gdelt") {
        cursor = row.id;
        continue;
      }
      break;
    }
    if (row.reviewStatus === "approved") fresh.push(row);
    // "rejected" rows are silently skipped — never sent, but safe to
    // advance past since that's a terminal state.
    cursor = row.id;
  }

  // 5s at the CDN: clients that started polling in the same second tend
  // to share a cursor for a while, and 5s is below the client's own poll
  // interval, so a hit is never staler than the next poll would be.
  return cachedJson({ events: fresh, cursor, reconcile: false }, 5, 5);
}
