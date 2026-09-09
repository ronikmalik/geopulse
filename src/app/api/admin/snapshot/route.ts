import { NextRequest, NextResponse } from "next/server";
import { snapshotCountryStates } from "@/lib/history";
import { gradeResolvedPredictions } from "@/lib/riskModelGrading";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 55;

// Daily cron (see vercel.ts) — records every country's current Pulse
// Level/momentum into country_state_history. See src/lib/history.ts.
//
// Also grades any shadow risk-model predictions whose 14-day window has
// resolved (src/lib/riskModelGrading.ts) — piggybacked here rather than
// its own route/cron: grading needs today's snapshot to exist first (a
// prediction resolving "today" checks against today's threatLevel), and
// grading is daily-cadence regardless of the weekly training cadence
// (.github/workflows/train-risk-model.yml), so there's no reason for it
// to be a separate cron entry.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const snapshot = await snapshotCountryStates();
  const grading = await gradeResolvedPredictions().catch((err) => {
    console.error(`riskModelGrading failed: ${err}`);
    return { graded: 0, correct: 0 };
  });
  return NextResponse.json({ snapshot, grading });
}
