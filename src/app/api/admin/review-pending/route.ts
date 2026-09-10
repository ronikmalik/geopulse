import { NextRequest, NextResponse } from "next/server";
import { reviewPendingEvents } from "@/lib/classifierAudit";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 55;

// Dedicated, frequent cadence for the pre-publish Gemini gate (2026-09-10,
// explicit user instruction: prioritize this over the backlog sweep, give
// it real leeway, decouple it from ingest's cramped 30s cron-job.org
// window). Previously reviewPendingEvents only ran as an 8s slice embedded
// in every runIngest cycle, racing classifierAuditSlice and everything
// else in that cycle for the same shared budget — AI Studio's own
// dashboard (checked live 2026-09-10) showed the audit model peaking at
// 490/500 RPD and 18/15 RPM, so "give it more leeway" can't mean more
// total daily requests (there's no free headroom, and billing is off the
// table) — it means spending the SAME budget reliably instead of getting
// truncated mid-round every cycle. See .github/workflows/review-pending.yml
// for the actual cadence (~every 15min, GitHub Actions has no 30s
// ceiling) and PENDING_REVIEW_DEADLINE_MS in classifierAudit.ts for why
// 15s specifically — sized to stay well under that RPD ceiling, not
// pushed to the edge of it the way the embedding model's cap was.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await reviewPendingEvents();
  return NextResponse.json(result);
}
