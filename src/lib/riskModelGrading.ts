import { and, isNull, lte, eq, gt, asc } from "drizzle-orm";
import { getDb } from "@/db";
import { riskPredictions, countryStateHistory } from "@/db/schema";
import { didEscalate } from "@/lib/riskModel";

// Daily grading pass (called from /api/admin/snapshot, right after that
// route's own snapshot write — grading a prediction whose window ends
// "today" needs today's snapshot to already exist). Finds shadow
// predictions whose 14-day window has resolved and haven't been graded
// yet, determines the real outcome using the SAME label logic training
// uses (riskModel.ts's didEscalate — not reimplemented here, so "was this
// prediction right" can never quietly drift from "was this a positive
// training example"), writes it back. This is the live, prospectively-
// graded calibration record — stronger evidence than a historical
// backtest alone, since these predictions were made before their outcome
// was knowable.
export interface GradingResult {
  graded: number;
  correct: number;
}

export async function gradeResolvedPredictions(): Promise<GradingResult> {
  const db = getDb();
  const resolvable = await db
    .select({
      id: riskPredictions.id,
      country: riskPredictions.country,
      generatedAt: riskPredictions.generatedAt,
      predictedProbability: riskPredictions.predictedProbability,
      inputFeatures: riskPredictions.inputFeatures,
    })
    .from(riskPredictions)
    .where(and(isNull(riskPredictions.actualOutcome), lte(riskPredictions.resolvesAt, new Date())));

  let graded = 0;
  let correct = 0;

  for (const pred of resolvable) {
    let startThreatLevel: number;
    try {
      const features = JSON.parse(pred.inputFeatures) as number[];
      startThreatLevel = features[0]; // FEATURE_NAMES[0] === "threatLevel", see riskModel.ts
    } catch {
      continue; // malformed row — skip rather than crash the whole pass
    }

    const laterSnapshots = await db
      .select({ threatLevel: countryStateHistory.threatLevel })
      .from(countryStateHistory)
      .where(
        and(
          eq(countryStateHistory.country, pred.country),
          gt(countryStateHistory.snapshotAt, pred.generatedAt),
        ),
      )
      .orderBy(asc(countryStateHistory.snapshotAt));

    const actualOutcome = didEscalate(startThreatLevel, laterSnapshots);
    const predictedOutcome = pred.predictedProbability >= 0.5;

    await db
      .update(riskPredictions)
      .set({ actualOutcome, gradedAt: new Date() })
      .where(eq(riskPredictions.id, pred.id));

    graded++;
    if (actualOutcome === predictedOutcome) correct++;
  }

  return { graded, correct };
}
