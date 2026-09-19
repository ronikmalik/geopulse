import { NextRequest } from "next/server";
import { getSimilarEvents } from "@/lib/similarEvents";
import { badRequest, cachedJson, parseIdParam } from "@/lib/apiParams";

// Read-only, unauthenticated like GET /api/events/duplicates (same
// public-article-links posture) — same ?id= convention rather than a
// dynamic route segment, for consistency with that route. Backs the
// "Similar events" section in FeedPanel's expanded card view. A pgvector
// nearest-neighbour query is the most expensive read this app serves per
// call, so a hot card's neighbours are CDN-cached for 5 minutes — the
// embedding corpus only grows ~12 rows per ingest cycle, so a 5-minute-
// old neighbour list is not meaningfully stale.
export async function GET(req: NextRequest) {
  const id = parseIdParam(req.nextUrl.searchParams.get("id"));
  if (!id) return badRequest("missing or invalid ?id=");
  const items = await getSimilarEvents(id);
  return cachedJson({ items }, 300);
}
