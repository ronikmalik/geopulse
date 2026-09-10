import { NextRequest, NextResponse } from "next/server";
import { trainAndEvaluateTextClassifier } from "@/lib/textClassifierTraining";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 120;

// Weekly cron via .github/workflows/train-text-classifier.yml — same
// GitHub-Actions reasoning as train-risk-model.yml/train-narrative-
// clusters.yml. Selects k via cross-validation over classification_
// archive's embedded, labeled corpus (src/lib/textClassifier.ts), then
// backtests against classifier_audit's doubly-vetted corrections. Nothing
// here is user-facing — see textClassifierRuns's own doc comment for the
// promotion gate. maxDuration is higher than the other two training
// routes (120s vs 55s) — cross-validation here does O(sample^2 / folds)
// distance computations, capped at MAX_CV_SAMPLE in textClassifier.ts but
// still meaningfully more compute than either the risk model's linear
// regression or narrative clustering's k-means.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await trainAndEvaluateTextClassifier();
  return NextResponse.json({ result });
}
