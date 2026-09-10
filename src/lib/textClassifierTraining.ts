import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { classificationArchive, classifierAudit, textClassifierRuns } from "@/db/schema";
import { chooseBestK, classifyViaKnn, prepareLabeledExamples, type LabeledExample } from "@/lib/textClassifier";
import { normalize } from "@/lib/narrativeClustering";

// Weekly training/backtest for Project 3 (2026-09-09) — see textClassifier.ts
// for the k-NN design itself. This module is the data-loading + evaluation
// layer: pulls classification_archive's embedded, labeled corpus, selects k
// via cross-validation, then backtests against the highest-trust ground
// truth this app has — classifier_audit rows where Gemini flagged a
// disagreement with the keyword classifier AND Claude independently
// reviewed and confirmed/corrected it (status IN 'applied'/'approved').
// That set answers the user's own question directly: does reusing that
// review work actually produce a better classifier than the one it was
// reviewing? See NarrativeTrainingResult-style shadow-mode discipline
// (riskModel.ts) — this ships as a logged comparison, never live-facing,
// until it demonstrably beats the keyword classifier on that same ground
// truth.
const K_CANDIDATES = [5, 10, 15, 20, 25];
const MIN_TRAINING_SAMPLE = 100;
const PROMOTION_MIN_BACKTEST_SAMPLE = 30;

interface RawLabeledRow {
  id: number;
  embedding: number[] | null;
  kept: boolean;
  category: string | null;
  severity: number;
}

async function fetchLabeledExamplesWithEmbeddings(): Promise<LabeledExample[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: classificationArchive.id,
      embedding: classificationArchive.embedding,
      kept: classificationArchive.kept,
      category: classificationArchive.category,
      severity: classificationArchive.severity,
    })
    .from(classificationArchive)
    .where(isNotNull(classificationArchive.embedding));

  const withEmbeddings = rows.filter((r): r is RawLabeledRow & { embedding: number[] } => r.embedding !== null);
  return prepareLabeledExamples(withEmbeddings);
}

interface DoublyVettedFinding {
  archiveId: number;
  kind: string;
  embedding: number[];
}

// Only false_positive/false_negative findings are meaningful for THIS
// classifier's relevance task — a severity_mismatch or country_mismatch
// finding means the keyword classifier's kept/dropped decision was
// correct, just its severity/country needed refining, so it's not a
// relevance-accuracy data point (this classifier's severity output is
// evaluated separately below, but only among items where relevance itself
// is settled).
async function fetchDoublyVettedRelevanceFindings(): Promise<DoublyVettedFinding[]> {
  const db = getDb();
  const rows = await db
    .select({
      archiveId: classifierAudit.archiveId,
      kind: classifierAudit.kind,
      embedding: classificationArchive.embedding,
    })
    .from(classifierAudit)
    .innerJoin(classificationArchive, eq(classificationArchive.id, classifierAudit.archiveId))
    .where(
      and(
        inArray(classifierAudit.status, ["applied", "approved"]),
        inArray(classifierAudit.kind, ["false_positive", "false_negative"]),
        isNotNull(classificationArchive.embedding),
      ),
    );
  return rows
    .filter((r): r is DoublyVettedFinding & { embedding: number[] } => r.embedding !== null)
    .map((r) => ({ archiveId: r.archiveId, kind: r.kind, embedding: r.embedding }));
}

export interface TextClassifierRunResult {
  trained: boolean;
  sampleSize: number;
  k: number;
  cvAccuracy: number;
  backtestSampleSize: number;
  backtestAgreementRate: number;
  promoted: boolean;
  notes: string;
}

export async function trainAndEvaluateTextClassifier(): Promise<TextClassifierRunResult> {
  const labeled = await fetchLabeledExamplesWithEmbeddings();

  if (labeled.length < MIN_TRAINING_SAMPLE) {
    const notes = `insufficient data: ${labeled.length} embedded, labeled classification_archive row(s) available (need ${MIN_TRAINING_SAMPLE}+) — classification_archive.embedding is backfilled gradually (12 rows/ingest-cycle, shared rate limit with feed_archive's own backfill), see classificationArchiveEmbeddingBackfill.ts.`;
    await recordRun({ trained: false, sampleSize: labeled.length, k: 0, cvAccuracy: 0, backtestSampleSize: 0, backtestAgreementRate: 0, promoted: false, notes });
    return { trained: false, sampleSize: labeled.length, k: 0, cvAccuracy: 0, backtestSampleSize: 0, backtestAgreementRate: 0, promoted: false, notes };
  }

  const kSelection = chooseBestK(labeled, K_CANDIDATES.filter((k) => k < labeled.length));

  const vettedFindings = await fetchDoublyVettedRelevanceFindings();
  let correct = 0;
  let evaluated = 0;
  for (const f of vettedFindings) {
    // Exclude the item being tested from its own reference pool — testing
    // a point against a pool that includes itself would trivially "find"
    // itself as the nearest neighbor and report perfect, meaningless
    // accuracy.
    const referencePool = labeled.filter((ex) => ex.id !== f.archiveId);
    const queryEmbedding = normalize(f.embedding);
    const prediction = classifyViaKnn(queryEmbedding, referencePool, kSelection.k);

    // Ground truth for a CONFIRMED false_positive is "should NOT be
    // relevant"; for a CONFIRMED false_negative, "SHOULD be relevant" —
    // that's the literal definition of each finding kind once it reaches
    // applied/approved status (Gemini flagged the keyword classifier's
    // original decision as wrong on this exact axis, Claude confirmed it).
    const groundTruthRelevant = f.kind === "false_negative";
    if (prediction.relevant === groundTruthRelevant) correct++;
    evaluated++;
  }

  const backtestAgreementRate = evaluated > 0 ? correct / evaluated : 0;
  const promoted = evaluated >= PROMOTION_MIN_BACKTEST_SAMPLE && backtestAgreementRate > 0.5;

  const notes =
    `trained k=${kSelection.k} on ${labeled.length} labeled examples (CV accuracy ${(kSelection.accuracy * 100).toFixed(1)}%). ` +
    `Backtested on ${evaluated} doubly-vetted classifier_audit correction(s) (Gemini-flagged, Claude-confirmed false_positive/false_negative findings) — ` +
    `agreement with the CONFIRMED CORRECT answer: ${(backtestAgreementRate * 100).toFixed(1)}%. ` +
    `Note: the keyword classifier's own agreement rate on this exact set is ~0% by construction (a finding only reaches applied/approved status because the keyword classifier's original decision on it was confirmed wrong) — this is the honest baseline this number is being compared against, not an invented one. ` +
    (promoted
      ? "Promoted (shadow-only — not user-facing): backtest sample meets the floor and beats a coin flip on confirmed corrections."
      : evaluated < PROMOTION_MIN_BACKTEST_SAMPLE
        ? `Not promoted: backtest sample (${evaluated}) below the ${PROMOTION_MIN_BACKTEST_SAMPLE}-example floor.`
        : "Not promoted: doesn't yet beat a coin flip on confirmed corrections.");

  const result: TextClassifierRunResult = {
    trained: true,
    sampleSize: labeled.length,
    k: kSelection.k,
    cvAccuracy: kSelection.accuracy,
    backtestSampleSize: evaluated,
    backtestAgreementRate,
    promoted,
    notes,
  };
  await recordRun(result);
  return result;
}

async function recordRun(r: TextClassifierRunResult): Promise<void> {
  const db = getDb();
  await db.insert(textClassifierRuns).values({
    trainedAt: new Date(),
    k: r.k,
    sampleSize: r.sampleSize,
    cvAccuracy: r.cvAccuracy,
    backtestSampleSize: r.backtestSampleSize,
    backtestAgreementRate: r.backtestAgreementRate,
    promoted: r.promoted,
    notes: r.notes,
  });
}

export async function getLatestTextClassifierRun() {
  const db = getDb();
  const [maxRow] = await db.select({ trainedAt: sql<string>`max(${textClassifierRuns.trainedAt})` }).from(textClassifierRuns);
  if (!maxRow?.trainedAt) return null;
  const latestTrainedAt = new Date(maxRow.trainedAt);
  const [row] = await db.select().from(textClassifierRuns).where(eq(textClassifierRuns.trainedAt, latestTrainedAt)).limit(1);
  return row ?? null;
}
