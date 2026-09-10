import { NextRequest, NextResponse } from "next/server";
import { trainAndShadowPredict } from "@/lib/riskModel";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 90;

// Weekly cron via .github/workflows/train-risk-model.yml (not vercel.ts —
// see that workflow's own doc comment for why: this project's established
// pattern for anything not strict-daily-floor duty is GitHub Actions, not
// growing vercel.ts's cron list). Trains the shadow risk model
// (src/lib/riskModel.ts) once per horizon in PREDICTION_HORIZONS_DAYS —
// as of Project 4 (2026-09-09), TWO model types per horizon
// (linear-regression and gradient-boosted-trees, champion/challenger —
// see riskModel.ts's MODEL_TYPES), each against the exact same labeled
// history/split, each backtested on its own real held-out data, each
// logging its own shadow predictions per country to be graded later
// (src/lib/riskModelGrading.ts, daily via /api/admin/snapshot).
// maxDuration raised from 55s to 90s accordingly (roughly double the
// model fits per horizon, and GBM's own nested hyperparameter search does
// meaningfully more compute per fit than linear regression's gradient
// descent). Nothing here is user-facing — see getLatestModelRun's own doc
// comment in riskModel.ts for the promotion/selection gate that would
// eventually change that.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const results = await trainAndShadowPredict();
  return NextResponse.json({ results });
}
