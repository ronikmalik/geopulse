import { NextRequest, NextResponse } from "next/server";
import { getSimilarEvents } from "@/lib/similarEvents";

// Read-only, unauthenticated like GET /api/events/duplicates (same
// public-article-links posture) — same ?id= convention rather than a
// dynamic route segment, for consistency with that route. Backs the
// "Similar events" section in FeedPanel's expanded card view.
export async function GET(req: NextRequest) {
  const idParam = req.nextUrl.searchParams.get("id");
  const id = idParam ? Number(idParam) : NaN;
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "missing or invalid ?id=" }, { status: 400 });
  }
  const items = await getSimilarEvents(id);
  return NextResponse.json({ items });
}
