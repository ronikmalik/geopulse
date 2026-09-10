import { NextRequest, NextResponse } from "next/server";
import { runIngest } from "@/lib/ingest";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 300;

// ?priority=1 runs PRIORITY_GDELT_QUERIES (political-instability/
// humanitarian at full frequency, plus the South/Central Asia gap queries —
// see categories.ts) instead of the normal one-category-per-cycle rotation,
// and skips every other source. Called by
// .github/workflows/ingest-priority.yml, a separate trigger from
// cron-job.org's main /api/ingest schedule specifically because it isn't
// bound by cron-job.org's 30s hard timeout — see runIngest's own comment.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const priorityGdelt = req.nextUrl.searchParams.get("priority") === "1";
  const result = await runIngest({ priorityGdelt });
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  return GET(req);
}
