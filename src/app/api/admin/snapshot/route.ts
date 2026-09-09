import { NextRequest, NextResponse } from "next/server";
import { snapshotCountryStates } from "@/lib/history";
import { gradeResolvedPredictions } from "@/lib/riskModelGrading";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 55;

// Daily cron (see vercel.ts) — records every country's current Pulse
// Level/momentum into country_state_history. See src/lib/history.ts.
//
// Also grades any shadow risk-model predictions whose horizon has
// resolved (src/lib/riskModelGrading.ts — each of PREDICTION_HORIZONS_DAYS
// resolves on its own clock, not just one fixed window) — piggybacked
// here rather than its own route/cron: grading needs today's snapshot to
// exist first (a prediction resolving "today" checks against today's
// score), and grading is daily-cadence regardless of the weekly training
// cadence (.github/workflows/train-risk-model.yml), so there's no reason
// for it to be a separate cron entry.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const snapshot = await snapshotCountryStates();
  const grading = await gradeResolvedPredictions().catch((err) => {
    console.error(`riskModelGrading failed: ${err}`);
    return { graded: 0, ungraded: 0 };
  });
  return NextResponse.json({ snapshot, grading });
}
