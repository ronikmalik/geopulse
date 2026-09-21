import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { isCronAuthorized } from "@/lib/cronAuth";

// Cache purge for the ISR-served read routes (2026-09-21). Called by the
// runner at the end of every ingest+review cycle (scripts/run-job.ts,
// purgeReadCaches) — the only moment new rows become visible — so a
// viewer's next poll of /api/events/feed regenerates once and every other
// viewer gets that copy. Header-only auth: this is a mutation of served
// state, and a leaked query string must not be enough to trigger it.
//
// The path list is fixed here rather than taken from the request body so
// the endpoint can never be pointed at an arbitrary path.
const PATHS = ["/api/events/feed"] as const;

export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req, { headerOnly: true })) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  for (const path of PATHS) revalidatePath(path);
  return NextResponse.json({ revalidated: [...PATHS], at: new Date().toISOString() });
}
