import { NextRequest, NextResponse } from "next/server";
import { getDuplicatesOf } from "@/lib/eventDedup";

// Read-only, unauthenticated like the other feed-serving routes — the
// duplicate rows are the same public news articles the primary event
// already links to. Backs the "N more sources" expansion in FeedPanel: a
// card with sourceCount > 0 (see src/lib/types.ts) calls this on demand
// rather than every event carrying its full duplicate list up front.
export async function GET(req: NextRequest) {
  const idParam = req.nextUrl.searchParams.get("id");
  const id = idParam ? Number(idParam) : NaN;
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "missing or invalid ?id=" }, { status: 400 });
  }
  const sources = await getDuplicatesOf(id);
  return NextResponse.json({ sources });
}
