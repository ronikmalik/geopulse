import { NextRequest, NextResponse } from "next/server";
import { trainAndShadowPredict } from "@/lib/riskModel";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 55;

// Weekly cron via .github/workflows/train-risk-model.yml (not vercel.ts —
// see that workflow's own doc comment for why: this project's established
// pattern for anything not strict-daily-floor duty is GitHub Actions, not
// growing vercel.ts's cron list). Trains the shadow risk model
// (src/lib/riskModel.ts) against whatever labeled history exists,
// backtests on real held-out data, and logs shadow predictions for every
// country to be graded later (src/lib/riskModelGrading.ts, daily via
// /api/admin/snapshot). Nothing here is user-facing — see riskModel.ts's
// own doc comment for the promotion gate that would eventually change
// that, not implemented in this pass.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await trainAndShadowPredict();
  return NextResponse.json(result);
}
