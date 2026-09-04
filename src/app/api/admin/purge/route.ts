import { NextRequest, NextResponse } from "next/server";
import { eq, and, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 55;

// Manual/occasional — deletes stored events from one source, by exact
// source string (e.g. "firms", "rss:al-jazeera"). Built for exactly the
// situation that motivated it: a source's scoring/clustering logic had a
// bug (see the 2026-09-04 comment in src/lib/sources/firms.ts) and its
// already-inserted rows needed purging so the next ingest cycle could
// repopulate cleanly under the fixed logic, rather than leaving stale
// bad-severity rows to decay out of the 3-day half-life on their own over
// the following week. Requires an exact `source` match (no wildcard/prefix
// delete) so this can't accidentally wipe more than intended.
//
// Optional `maxSeverity` narrows to only rows at or below that severity —
// added the same day for the Telegram severity-bar-raise cleanup: rows
// inserted under an old, looser threshold (e.g. severity 2, before
// MIN_SEVERITY_TO_INCLUDE went to 3) needed purging without also deleting
// the same source's legitimate severity-3+ rows alongside them.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const source = req.nextUrl.searchParams.get("source");
  if (!source) {
    return NextResponse.json({ error: "missing ?source=" }, { status: 400 });
  }
  const maxSeverityParam = req.nextUrl.searchParams.get("maxSeverity");
  const maxSeverity = maxSeverityParam ? Number(maxSeverityParam) : null;
  if (maxSeverityParam && (!Number.isInteger(maxSeverity) || maxSeverity === null)) {
    return NextResponse.json({ error: "maxSeverity must be an integer" }, { status: 400 });
  }

  const db = getDb();
  const condition =
    maxSeverity !== null
      ? and(eq(events.source, source), lt(events.severity, maxSeverity + 1))
      : eq(events.source, source);
  const result = await db.delete(events).where(condition).returning({ id: events.id });
  return NextResponse.json({ source, maxSeverity, deleted: result.length });
}
