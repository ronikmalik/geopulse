import { NextRequest, after } from "next/server";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { desc, gt, isNull, and, eq, sql, getTableColumns } from "drizzle-orm";
import { withCache } from "@/lib/layerCache";

// Cross-outlet duplicates (see src/lib/eventDedup.ts) are hidden from the
// main feed — only primaries (primaryEventId IS NULL) stream here.
// sourceCount tells the client whether to show a "N more sources"
// affordance without a round-trip per card; the actual duplicate rows are
// fetched on demand via GET /api/events/duplicates when a card with
// sourceCount > 0 is expanded.
//
// APPROVED_ONLY (2026-09-08 user request): the live feed only ever shows
// events that have cleared Gemini's pre-publish review (or were direct/
// structural, which skip the gate entirely — see reviewStatus's doc
// comment in schema.ts) — a freshly-classified RSS/GDELT/Telegram item
// sits invisible here as "pending" until reviewPendingEvents promotes it,
// usually within this or the next ~15min ingest cycle.
const PRIMARY_ONLY = isNull(events.primaryEventId);
const APPROVED_ONLY = eq(events.reviewStatus, "approved");

// GDELT backlog filter (2026-09-11 user request): gdeltBulk.ts's
// DRAIN_BATCH_SIZE/CONCURRENCY fix (100/100) is still working through a
// multi-thousand-row backlog in pending_gdelt_title — see that table's own
// doc comment — so a gdelt item approved right now can carry a publishedAt
// 10+ hours in the past. Interleaving those next to genuinely-fresh
// headlines made the top of the feed look stuck even while real approvals
// kept flowing. Scoped to gdelt only; every other source already resolves
// within minutes of its own publishedAt (verified 2026-09-11), so this is
// a no-op for them. Deliberately self-obsoleting rather than a flag to
// remember to remove later: once the backlog is actually drained, no gdelt
// item will ever again be approved with a publishedAt this old, so this
// stops excluding anything on its own with no future cleanup step — and if
// a discovery burst ever outpaces drain capacity again, it quietly
// protects the feed again without a redeploy.
const GDELT_BACKLOG_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const NOT_STALE_GDELT_BACKLOG = sql`(${events.source} != 'gdelt' or ${events.publishedAt} > now() - interval '3 hours')`;
function isStaleGdeltBacklog(row: { source: string; publishedAt: string | Date }): boolean {
  return row.source === "gdelt" && new Date(row.publishedAt).getTime() < Date.now() - GDELT_BACKLOG_MAX_AGE_MS;
}

const withSourceCount = {
  ...getTableColumns(events),
  sourceCount: sql<number>`(select count(*) from ${events} e2 where e2.primary_event_id = ${events.id})`.as(
    "sourceCount",
  ),
};

// Vercel Hobby-tier serverless functions hard-cap at 60s regardless of this
// export; Pro/Enterprise allow more. Set to the safe lowest common
// denominator rather than the platform ceiling — see MAX_STREAM_MS below
// for why the loop never actually runs this long anyway.
export const maxDuration = 55;

const POLL_INTERVAL_MS = 4000;
const INITIAL_BACKFILL_LIMIT = 100;
// The stream voluntarily closes itself well before any plausible platform
// timeout (rather than getting killed mid-response, which the client sees
// as a hung connection with no clean "error" signal to react to quickly).
// The client (useEventStream.ts) reconnects with ?since=<lastId> within
// ~1s of a clean close, so this rotation is invisible in practice — a
// resumed stream, not a real disconnect.
const MAX_STREAM_MS = 45_000;

// The intended external cron (GitHub Actions, .github/workflows/ingest.yml)
// is not reliably driving ingestion — this app has gone stale without it.
// Rather than depend entirely on infrastructure outside this repo, every
// new stream connection opportunistically kicks off an ingest run in the
// background if the feed looks stale. withCache gates this to at most once
// per this interval per warm serverless instance, so an actively-watched
// page (which reconnects roughly every 45s, see MAX_STREAM_MS) doesn't
// trigger overlapping ingest runs. This makes "someone has the site open"
// sufficient to keep the feed live, with the daily Vercel cron and the
// GitHub Actions workflow as additional (if unreliable) backups.
//
// This fires an actual HTTP request to /api/ingest (a separate serverless
// invocation with its own maxDuration budget) rather than calling
// runIngest() in-process here — this route's own lifecycle ends (and its
// execution environment can be torn down) well before a full ingest run
// finishes, which would silently kill an in-process fire-and-forget call.
// `after()` ensures the outbound request actually gets dispatched instead
// of being cut off when this route's response completes.
const BACKGROUND_INGEST_INTERVAL_MS = 10 * 60_000;

function triggerBackgroundIngest(origin: string) {
  withCache(
    "stream:background-ingest-trigger",
    BACKGROUND_INGEST_INTERVAL_MS,
    async () => {
      after(() => {
        // /api/ingest is gated by CRON_SECRET (see cronAuth.ts) — this call
        // was previously sent with no auth at all, so it silently got a 401
        // on every single invocation in production (fetch() doesn't throw
        // on non-2xx, so the .catch() below never saw it). This entire
        // "keep the feed live opportunistically" fallback was dead code
        // ever since CRON_SECRET was introduced.
        const secret = process.env.CRON_SECRET;
        const headers = secret ? { Authorization: `Bearer ${secret}` } : undefined;
        fetch(new URL("/api/ingest", origin), { headers }).catch((err) => {
          console.error(`Background ingest trigger (from stream) failed: ${err}`);
        });
      });
      return true;
    },
  ).catch(() => {
    // Best-effort — a failed trigger just means we try again next connection.
  });
}

function toSseMessage(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(req: NextRequest) {
  const db = getDb();
  const encoder = new TextEncoder();
  const sinceParam = req.nextUrl.searchParams.get("since");
  let lastId = sinceParam ? Number(sinceParam) : 0;

  triggerBackgroundIngest(req.nextUrl.origin);

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const startedAt = Date.now();
      req.signal.addEventListener("abort", () => {
        closed = true;
      });

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(toSseMessage(event, data)));
        } catch {
          closed = true;
        }
      };

      // Initial backfill so a fresh client sees recent alerts immediately.
      if (!sinceParam) {
        const recent = await db
          .select(withSourceCount)
          .from(events)
          .where(and(PRIMARY_ONLY, APPROVED_ONLY, NOT_STALE_GDELT_BACKLOG))
          .orderBy(desc(events.id))
          .limit(INITIAL_BACKFILL_LIMIT);
        const ordered = recent.reverse();
        send("backfill", ordered);
        if (ordered.length > 0) {
          lastId = ordered[ordered.length - 1].id;
        }
      }

      // Ids already sent this connection — see the loop below for why this
      // is needed alongside lastId rather than lastId alone.
      const sentIds = new Set<number>();

      while (!closed && Date.now() - startedAt < MAX_STREAM_MS) {
        try {
          // Deliberately NOT filtered to approved-only in the query itself
          // — a naive `gt(id, lastId) AND approved` filter has a real gap:
          // if row 105 is still pending when row 106 (already approved)
          // gets fetched and sent, lastId advances to 106, and a later
          // gt(id, 106) query can never see row 105 again even once it's
          // promoted — permanently skipping it for this connection. So
          // lastId only advances through a CONTIGUOUS prefix of resolved
          // (approved-and-sent, or rejected) rows; a still-pending row
          // halts the advance and gets re-checked every poll until it
          // resolves. That means rows past the halt point get re-fetched
          // on later polls too — sentIds (bounded to this connection's
          // lifetime, which self-rotates every MAX_STREAM_MS) is what
          // stops those from being sent to the client twice.
          const candidates = await db
            .select(withSourceCount)
            .from(events)
            .where(and(gt(events.id, lastId), PRIMARY_ONLY))
            .orderBy(events.id)
            .limit(50);

          let advanceTo = lastId;
          let sawUnresolvedPending = false;
          for (const row of candidates) {
            if (row.reviewStatus === "pending") {
              // gdelt is exempt from the ordering-halt below (2026-09-10):
              // classifierAudit.ts's pending-review safety net no longer
              // auto-promotes stale gdelt rows (see its own doc comment —
              // "everything that does appear should be highly credible", a
              // deliberate uncapped delay for that one source). Every OTHER
              // source still resolves within PENDING_REVIEW_MAX_AGE_MINUTES,
              // so this loop's original bound (a pending row blocks for at
              // most ~30min) no longer holds for gdelt specifically — a
              // single gdelt row stuck pending indefinitely would otherwise
              // stall live toast delivery for every other source's events
              // forever, not just delay them. Advance past it like a
              // rejected row instead of blocking: this connection simply
              // won't get a live toast for it if it resolves later (a fresh
              // page load/reconnect still picks it up via the approved-only
              // backfill query above), which is a far smaller tradeoff than
              // an unbounded stream stall.
              if (row.source === "gdelt") {
                // Only safe to skip past if nothing earlier in THIS batch
                // is already blocking — an actual (non-gdelt) unresolved
                // pending row must still halt everything after it,
                // gdelt included, or a later poll's gt(id, lastId) query
                // would lose track of that real blocker forever.
                if (!sawUnresolvedPending) advanceTo = row.id;
                continue;
              }
              sawUnresolvedPending = true;
              continue;
            }
            // 2026-09-09 fix: this used to send() an approved row here
            // unconditionally, even after sawUnresolvedPending had already
            // gone true this batch — meaning row 106 (approved) got sent
            // to the client immediately while row 105 (lower id, still
            // pending) hadn't resolved yet, then row 105 arrived as its
            // own "new" toast one or more polls later, once review caught
            // up. From the client's point of view that's a toast for an
            // older event appearing chronologically AFTER a newer one it
            // already saw — exactly the "glitchy out-of-order popup" bug
            // reported live. Skipping every row once a pending gap is seen
            // (not just skipping the advance) keeps send order identical
            // to advance order: strictly ascending, chronological, and
            // never revisited out of turn. Rows past the halt point still
            // get re-checked (and, once resolved, sent+advanced in order)
            // on later polls — same as before, just no longer jumping
            // ahead of the row that's blocking them.
            if (sawUnresolvedPending) continue;
            if (row.reviewStatus === "approved" && !sentIds.has(row.id) && !isStaleGdeltBacklog(row)) {
              send("event", row);
              sentIds.add(row.id);
            }
            // "rejected" rows are silently skipped — never sent, but safe
            // to advance the cursor past since that's a terminal state.
            // A stale gdelt-backlog row (see NOT_STALE_GDELT_BACKLOG above)
            // gets the same treatment: approved, but deliberately not sent.
            advanceTo = row.id;
          }
          lastId = advanceTo;

          send("ping", { lastId, t: Date.now() });
        } catch (err) {
          // Logged server-side only — this stream has no auth, so a raw
          // exception (query text, column names, etc.) has no business
          // going out to an anonymous client. The client doesn't even
          // listen for this event type today (see useEventStream.ts); it's
          // sent purely so a future consumer has something to react to
          // without us having to remember to sanitize it then too.
          console.error(`/api/stream poll failed: ${err}`);
          send("error", { message: "internal error" });
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      // If `closed` became true via the client-abort listener (rather than
      // the MAX_STREAM_MS self-rotation), the runtime may have already run
      // this stream's own cancel() algorithm on disconnect — closing an
      // already-cancelled controller throws. Same defensive pattern as
      // send() above, which guards enqueue() the same way.
      try {
        controller.close();
      } catch {
        // Already closed/cancelled by the client disconnecting — fine.
      }
    },
    cancel() {
      // client disconnected
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
