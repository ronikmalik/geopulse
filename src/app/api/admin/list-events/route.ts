import { NextRequest, NextResponse } from "next/server";
import { and, eq, gt, like } from "drizzle-orm";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 55;

// Read-only counterpart to /api/admin/purge — built for the same kind of
// one-off need: auditing already-stored rows against the current
// classifier standard (see classify.ts) to decide what to purge, without
// guessing from the ~100-item /api/stream buffer or iterating every
// country through /api/events?country=. Scoped to `source` (exact) or
// `sourcePrefix` (LIKE 'prefix%', for multi-outlet sources like
// "rss:meduza"/"telegram:presstv") and a `days` lookback (default matches
// risk.ts's LOOKBACK_DAYS=30, i.e. "still actually live in the feed", not
// literally every row ever inserted).
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const source = req.nextUrl.searchParams.get("source");
  const sourcePrefix = req.nextUrl.searchParams.get("sourcePrefix");
  if (!source && !sourcePrefix) {
    return NextResponse.json(
      { error: "missing ?source= or ?sourcePrefix=" },
      { status: 400 },
    );
  }
  const daysParam = req.nextUrl.searchParams.get("days");
  const days = daysParam ? Number(daysParam) : 30;
  if (!Number.isInteger(days) || days <= 0) {
    return NextResponse.json({ error: "days must be a positive integer" }, { status: 400 });
  }

  const db = getDb();
  const sourceFilter = source
    ? eq(events.source, source)
    : like(events.source, `${sourcePrefix}%`);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60_000);

  try {
    const rows = await db
      .select({
        id: events.id,
        source: events.source,
        url: events.url,
        title: events.title,
        summary: events.summary,
        category: events.category,
        country: events.country,
        severity: events.severity,
        publishedAt: events.publishedAt,
        createdAt: events.createdAt,
      })
      .from(events)
      .where(and(sourceFilter, gt(events.publishedAt, cutoff)));

    return NextResponse.json({
      receivedParams: { source, sourcePrefix, days },
      count: rows.length,
      rows,
    });
  } catch (err) {
    return NextResponse.json(
      {
        receivedParams: { source, sourcePrefix, days },
        error: String(err),
        stack: err instanceof Error ? err.stack : null,
      },
      { status: 500 },
    );
  }
}
