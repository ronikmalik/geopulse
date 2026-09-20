import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { recordModelRun } from "@/lib/modelRegistry";
import { classificationArchive, classifierAudit, textClassifierRuns } from "@/db/schema";
import { chooseBestK, classifyViaKnn, prepareLabeledExamples, type LabeledExample } from "@/lib/textClassifier";
import { normalize } from "@/lib/narrativeClustering";
import { getHumanLabelledExamples } from "@/lib/gateReview";

// Shadow evaluation of the embedded classification archive. Select k within
// the reference pool, then measure agreement with held-out audit corrections.
// Applied/approved status can come from automatic review; these selected
// corrections are not independent, representative ground truth and cannot
// authorize automatic promotion.
const K_CANDIDATES = [5, 10, 15, 20, 25];
const MIN_TRAINING_SAMPLE = 100;
// Promotion criterion (2026-09-20), replacing the permanent
// `promoted = false`: once at least this many gate decisions have been
// graded by a human (gate_review_samples, see gateReview.ts), the shadow
// classifier is scored on exactly those rows and promoted only if it
// beats the LIVE GATE's own accuracy on the same rows. That's the one
// comparison that means anything — the corrections-only challenge set
// below measures agreement with Gemini's audit, not with a person.
// "Promoted" is still shadow-only (a logged flag nothing consumes yet);
// it just stops being unreachable by construction.
const HUMAN_EVAL_MIN_SAMPLE = 50;

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

interface AuditCorrection {
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
async function fetchAuditCorrections(): Promise<AuditCorrection[]> {
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
    .filter((r): r is AuditCorrection & { embedding: number[] } => r.embedding !== null)
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

  const auditCorrections = await fetchAuditCorrections();
  // Keep the entire correction challenge set out of both k selection and
  // neighbor pools. Leave-one-out alone lets other evaluation labels leak.
  const challengeIds = new Set(auditCorrections.map((finding) => finding.archiveId));
  const training = labeled.filter((example) => !challengeIds.has(example.id));
  if (training.length < MIN_TRAINING_SAMPLE) {
    const result = { trained: false, sampleSize: training.length, k: 0, cvAccuracy: 0, backtestSampleSize: auditCorrections.length, backtestAgreementRate: 0, promoted: false, notes: "Insufficient training data after excluding the correction challenge set." };
    await recordRun(result);
    return result;
  }
  const kSelection = chooseBestK(training, K_CANDIDATES.filter((k) => k < training.length));
  let correct = 0;
  let evaluated = 0;
  for (const f of auditCorrections) {
    // Exclude the item being tested from its own reference pool — testing
    // a point against a pool that includes itself would trivially "find"
    // itself as the nearest neighbor and report perfect, meaningless
    // accuracy.
    const referencePool = training;
    const queryEmbedding = normalize(f.embedding);
    const prediction = classifyViaKnn(queryEmbedding, referencePool, kSelection.k, kSelection.weighting);

    // The audit decision supplies a challenge label, not independently
    // verified truth. Report agreement with that decision.
    const groundTruthRelevant = f.kind === "false_negative";
    if (prediction.relevant === groundTruthRelevant) correct++;
    evaluated++;
  }

  const backtestAgreementRate = evaluated > 0 ? correct / evaluated : 0;

  // Human-graded evaluation (see HUMAN_EVAL_MIN_SAMPLE). Graded rows are
  // excluded from the reference pool too — same leakage discipline as the
  // correction challenge set.
  const human = await evaluateAgainstHumanLabels(training, kSelection.k, kSelection.weighting);
  const promoted = human.evaluated >= HUMAN_EVAL_MIN_SAMPLE && human.knnAccuracy > human.gateAccuracy;

  const notes =
    `trained k=${kSelection.k} (${kSelection.weighting} vote weighting, selected jointly with k by 3-fold CV) on ${training.length} labeled examples (CV agreement with archived labels ${(kSelection.accuracy * 100).toFixed(1)}%). ` +
    `Evaluated on ${evaluated} audit corrections (may include automatic reviews) — ` +
    `agreement with audit decisions: ${(backtestAgreementRate * 100).toFixed(1)}%. ` +
    `Human-graded evaluation: ${human.evaluated} gate decision(s) graded by a person${human.evaluated > 0 ? ` — k-NN accuracy ${(human.knnAccuracy * 100).toFixed(1)}% vs the live gate's ${(human.gateAccuracy * 100).toFixed(1)}% on the same rows` : ""}. ` +
    (promoted
      ? `Promoted (shadow-only flag): beats the live gate on >= ${HUMAN_EVAL_MIN_SAMPLE} human-graded rows.`
      : human.evaluated < HUMAN_EVAL_MIN_SAMPLE
        ? `Not promoted: fewer than ${HUMAN_EVAL_MIN_SAMPLE} human-graded rows yet (grade more at /admin/gate-review).`
        : "Not promoted: does not beat the live gate on human-graded rows.");

  const result: TextClassifierRunResult = {
    trained: true,
    sampleSize: training.length,
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

// Scores the classifier on the human-graded gate sample. Rows without an
// embedded classification_archive twin are skipped (the sample stores the
// url, and the archive is what carries the embedding).
async function evaluateAgainstHumanLabels(
  referencePool: LabeledExample[],
  k: number,
  weighting: "uniform" | "distance",
): Promise<{ evaluated: number; knnAccuracy: number; gateAccuracy: number }> {
  const graded = await getHumanLabelledExamples();
  if (graded.length === 0) return { evaluated: 0, knnAccuracy: 0, gateAccuracy: 0 };
  const db = getDb();
  const rows = await db
    .select({ id: classificationArchive.id, url: classificationArchive.url, embedding: classificationArchive.embedding })
    .from(classificationArchive)
    .where(and(inArray(classificationArchive.url, graded.map((g) => g.url)), isNotNull(classificationArchive.embedding)));
  const embeddingByUrl = new Map(rows.map((r) => [r.url, r.embedding as number[]]));
  const gradedArchiveIds = new Set(rows.map((r) => r.id));
  // Never let a graded row vote on itself or on another graded row.
  const pool = referencePool.filter((ex) => !gradedArchiveIds.has(ex.id));
  let evaluated = 0;
  let knnCorrect = 0;
  let gateCorrect = 0;
  for (const g of graded) {
    const embedding = embeddingByUrl.get(g.url);
    if (!embedding) continue;
    const prediction = classifyViaKnn(normalize(embedding), pool, k, weighting);
    evaluated++;
    if (prediction.relevant === g.relevant) knnCorrect++;
    if (g.gateCorrect) gateCorrect++;
  }
  return {
    evaluated,
    knnAccuracy: evaluated > 0 ? knnCorrect / evaluated : 0,
    gateAccuracy: evaluated > 0 ? gateCorrect / evaluated : 0,
  };
}

async function recordRun(r: TextClassifierRunResult): Promise<void> {
  const db = getDb();
  const [run] = await db
    .insert(textClassifierRuns)
    .values({
      trainedAt: new Date(),
      k: r.k,
      sampleSize: r.sampleSize,
      cvAccuracy: r.cvAccuracy,
      backtestSampleSize: r.backtestSampleSize,
      backtestAgreementRate: r.backtestAgreementRate,
      promoted: r.promoted,
      notes: r.notes,
    })
    .returning({ id: textClassifierRuns.id });
  await recordModelRun({
    family: "text-classifier",
    variant: `knn/k=${r.k}`,
    sampleSize: r.sampleSize,
    backtestSampleSize: r.backtestSampleSize,
    featureNames: ["embedding(768)"],
    metrics: { cvAccuracy: r.cvAccuracy, auditAgreementRate: r.backtestAgreementRate },
    baseline: { name: "live Gemini gate (human-graded rows)", note: "promotion requires beating it on ≥ 50 graded rows" },
    trained: r.trained,
    promoted: r.promoted,
    notes: r.notes,
    sourceTable: "text_classifier_runs",
    sourceId: run.id,
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
