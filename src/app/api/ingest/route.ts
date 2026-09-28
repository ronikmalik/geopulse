import { NextRequest, NextResponse } from "next/server";
import { runIngest } from "@/lib/ingest";
import { isCronAuthorized } from "@/lib/cronAuth";
import { lastIngestSuccessAt } from "@/lib/sourceHealth";

export const maxDuration = 300;

// The daily Vercel cron (vercel.ts) is a floor for when the GitHub-scheduled
// pipeline has gone quiet. On a normal day that pipeline ingested minutes
// earlier and the cron repeated the whole run on Vercel's metered CPU for
// nothing, so it now stands down when the last successful ingest is this
// recent (2026-09-28). Manual calls always run.
const FLOOR_SKIP_IF_INGESTED_WITHIN_MS = 90 * 60_000;

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
  // Vercel sets x-vercel-cron-schedule on every cron invocation (documented
  // at vercel.com/docs/cron-jobs/manage-cron-jobs).
  if (req.headers.has("x-vercel-cron-schedule")) {
    const last = await lastIngestSuccessAt().catch(() => null);
    if (last && Date.now() - last.getTime() < FLOOR_SKIP_IF_INGESTED_WITHIN_MS) {
      return NextResponse.json({ skipped: "scheduled pipeline is running", lastIngestSuccessAt: last.toISOString() });
    }
  }
  const priorityGdelt = req.nextUrl.searchParams.get("priority") === "1";
  const result = await runIngest({ priorityGdelt });
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  return GET(req);
}
