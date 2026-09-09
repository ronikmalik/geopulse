import { and, isNull, lte, eq, gte } from "drizzle-orm";
import { getDb } from "@/db";
import { riskPredictions, countryStateHistory } from "@/db/schema";
import { findClosestSnapshot } from "@/lib/riskModel";

// Daily grading pass (called from /api/admin/snapshot, right after that
// route's own snapshot write — grading a prediction whose window ends
// "today" needs today's snapshot to already exist). Finds shadow
// predictions whose horizon has resolved and haven't been graded yet,
// finds the actual score/threatLevel using the SAME closest-within-
// tolerance matching riskModel.ts's training uses (findClosestSnapshot —
// not reimplemented here, so "how training matched a target" and "how
// grading matches an outcome" can never quietly drift apart), writes it
// back. This is the live, prospectively-graded calibration record —
// stronger evidence than a historical backtest alone, since these
// predictions were made before their outcome was knowable.
export interface GradingResult {
  graded: number;
  ungraded: number; // still waiting on a snapshot within tolerance of resolvesAt
}

export async function gradeResolvedPredictions(): Promise<GradingResult> {
  const db = getDb();
  const resolvable = await db
    .select({
      id: riskPredictions.id,
      country: riskPredictions.country,
      resolvesAt: riskPredictions.resolvesAt,
      predictedScore: riskPredictions.predictedScore,
    })
    .from(riskPredictions)
    .where(and(isNull(riskPredictions.actualScore), lte(riskPredictions.resolvesAt, new Date())));

  if (resolvable.length === 0) return { graded: 0, ungraded: 0 };

  // Fetch each involved country's snapshots once, not once per
  // prediction — a country can have several ungraded predictions
  // (different horizons/training runs) all wanting the same lookup.
  const countries = [...new Set(resolvable.map((p) => p.country))];
  const snapshotsByCountry = new Map<
    string,
    { snapshotAt: Date; score: number; threatLevel: number }[]
  >();
  for (const country of countries) {
    const rows = await db
      .select({
        snapshotAt: countryStateHistory.snapshotAt,
        score: countryStateHistory.score,
        threatLevel: countryStateHistory.threatLevel,
      })
      .from(countryStateHistory)
      .where(
        and(
          eq(countryStateHistory.country, country),
          // Only need snapshots from around when predictions for this
          // country could plausibly resolve — bounding this avoids
          // pulling a country's entire history just to grade one recent
          // prediction.
          gte(countryStateHistory.snapshotAt, new Date(Date.now() - 30 * 86_400_000)),
        ),
      )
      .orderBy(countryStateHistory.snapshotAt);
    snapshotsByCountry.set(country, rows);
  }

  let graded = 0;
  let ungraded = 0;

  for (const pred of resolvable) {
    const sorted = snapshotsByCountry.get(pred.country) ?? [];
    const actual = findClosestSnapshot(sorted, pred.resolvesAt.getTime());
    if (!actual) {
      ungraded++; // no snapshot within tolerance yet — a real data gap, try again later
      continue;
    }

    await db
      .update(riskPredictions)
      .set({
        actualScore: actual.score,
        actualThreatLevel: actual.threatLevel,
        absoluteError: Math.abs(pred.predictedScore - actual.score),
        gradedAt: new Date(),
      })
      .where(eq(riskPredictions.id, pred.id));
    graded++;
  }

  return { graded, ungraded };
}
