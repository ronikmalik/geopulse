import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, gt, like } from "drizzle-orm";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 55;
// A GET route handler reading searchParams is usually dynamic by default,
// but two specific query strings here (sourcePrefix=rss:, sourcePrefix=
// telegram:) got cached empty at Vercel's edge the very first time they
// were hit — while the app itself still had a real bug — and kept serving
// that stale cached response on every retry afterward, across multiple
// unrelated code fixes and redeploys, because the cache key is the exact
// URL+query string, not tied to which deployment is live. Confirmed via a
// never-before-hit URL with the same params working immediately.
// force-dynamic rules this out for good.
export const dynamic = "force-dynamic";

// Read-only counterpart to /api/admin/purge — built for the same kind of
// one-off need: auditing already-stored rows against the current
// classifier standard (see classify.ts) to decide what to purge, without
// guessing from the ~100-item /api/stream buffer or iterating every
// country through /api/events?country=. Scoped to `source` (exact) or
// `sourcePrefix` (LIKE 'prefix%', for multi-outlet sources like
// "rss:meduza"/"telegram:presstv") and a `days` lookback (default matches
// risk.ts's LOOKBACK_DAYS=30, i.e. "still actually live in the feed", not
// literally every row ever inserted).
//
// Paginated via `afterId` (only rows with id > afterId, ordered by id
// ascending) + `limit` (default 100) — a broad sourcePrefix query over the
// full 30-day window can return hundreds of rows, and the first
// unpaginated version of this route genuinely worked server-side but
// produced a single JSON response line long enough that GitHub Actions'
// log capture (the only way to read this endpoint's output, since
// CRON_SECRET only exists as a GitHub secret) silently dropped it
// entirely — indistinguishable from a real empty/broken response without
// directly inspecting a shorter, provably-working request first. Trimmed
// response fields (no summary/country/createdAt) for the same reason —
// summary duplicates title for every classifier-governed source (both
// classifyGdeltItem and classifyByKeywords set summary: item.title), so
// it's pure payload bloat for this endpoint's actual purpose.
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
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : 100;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
    return NextResponse.json({ error: "limit must be 1-500" }, { status: 400 });
  }
  const afterIdParam = req.nextUrl.searchParams.get("afterId");
  const afterId = afterIdParam ? Number(afterIdParam) : 0;
  if (!Number.isInteger(afterId) || afterId < 0) {
    return NextResponse.json({ error: "afterId must be a non-negative integer" }, { status: 400 });
  }

  const db = getDb();
  const sourceFilter = source
    ? eq(events.source, source)
    : like(events.source, `${sourcePrefix}%`);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60_000);

  const rows = await db
    .select({
      id: events.id,
      source: events.source,
      url: events.url,
      title: events.title,
      category: events.category,
      severity: events.severity,
      publishedAt: events.publishedAt,
    })
    .from(events)
    .where(
      and(sourceFilter, gt(events.publishedAt, cutoff), gt(events.id, afterId)),
    )
    .orderBy(asc(events.id))
    .limit(limit);

  return NextResponse.json({ count: rows.length, rows });
}
