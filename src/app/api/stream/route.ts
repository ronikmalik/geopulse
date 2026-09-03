import { NextRequest } from "next/server";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { desc, gt } from "drizzle-orm";
import { runIngest } from "@/lib/ingest";
import { withCache } from "@/lib/layerCache";

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
const BACKGROUND_INGEST_INTERVAL_MS = 10 * 60_000;

function triggerBackgroundIngest() {
  withCache(
    "stream:background-ingest-trigger",
    BACKGROUND_INGEST_INTERVAL_MS,
    async () => {
      runIngest().catch((err) => {
        console.error(`Background ingest (from stream) failed: ${err}`);
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

  triggerBackgroundIngest();

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
          .select()
          .from(events)
          .orderBy(desc(events.id))
          .limit(INITIAL_BACKFILL_LIMIT);
        const ordered = recent.reverse();
        send("backfill", ordered);
        if (ordered.length > 0) {
          lastId = ordered[ordered.length - 1].id;
        }
      }

      while (!closed && Date.now() - startedAt < MAX_STREAM_MS) {
        try {
          const fresh = await db
            .select()
            .from(events)
            .where(gt(events.id, lastId))
            .orderBy(events.id)
            .limit(50);

          for (const row of fresh) {
            send("event", row);
            lastId = row.id;
          }

          send("ping", { lastId, t: Date.now() });
        } catch (err) {
          send("error", { message: String(err) });
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      controller.close();
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
