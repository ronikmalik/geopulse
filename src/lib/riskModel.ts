import { desc } from "drizzle-orm";
import { getDb } from "@/db";
import { countryStateHistory, riskModelRuns, riskPredictions } from "@/db/schema";
import {
  trainLogisticRegression,
  evaluateBacktest,
  predictProbability,
  DEFAULT_TRAIN_CONFIG,
  type LogisticRegressionModel,
} from "@/lib/logisticRegression";

// Shadow-mode predictive risk model (2026-09-09). See the doc comment on
// riskModelRuns/riskPredictions in src/db/schema.ts for the storage
// design, and this session's plan file for the full reasoning. Nothing
// here is user-facing yet — this trains, backtests against real held-out
// history, and logs shadow predictions to be graded later
// (riskModelGrading.ts) once their 14-day windows actually resolve. A
// model only ever gets shown to users once it's earned that via measured
// backtest + live-graded accuracy, not a guessed calendar date.
const LABEL_WINDOW_DAYS = 14;
const ESCALATION_THRESHOLD = 2; // threatLevel jump of +2 or more within the window
const FEATURE_NAMES = ["threatLevel", "score", "momentum", "momentumDirection", "eventCount"];
const TEST_SPLIT_FRACTION = 0.2;
// Below this, don't even attempt a fit — a handful of points isn't a
// model, it's noise with extra steps. This is deliberately much lower
// than the promotion floor (see PROMOTION_MIN_BACKTEST_SAMPLE below):
// this gate is "is there anything to learn from at all," promotion is
// "has it actually been validated."
const MIN_TRAINING_SAMPLE = 10;
const PROMOTION_MIN_BACKTEST_SAMPLE = 30;

interface Snapshot {
  country: string;
  snapshotAt: Date;
  score: number;
  threatLevel: number;
  momentum: number;
  momentumDirection: number;
  eventCount: number;
}

export interface LabeledExample {
  country: string;
  snapshotAt: Date;
  features: number[]; // FEATURE_NAMES order
  label: 0 | 1;
}

// The part that has to be exactly right — see the plan's own emphasis on
// this. Label = 1 as soon as a later snapshot within the window shows the
// jump (doesn't need to wait out the full window). Label = 0 only once
// the FULL window has already elapsed with no jump seen. A snapshot whose
// window hasn't elapsed AND hasn't already jumped is excluded entirely —
// treating "no jump yet" as a confirmed negative before the window has
// even had a chance to resolve would silently poison every recent
// snapshot as a false negative.
export function buildLabeledExamples(all: Snapshot[]): LabeledExample[] {
  const byCountry = new Map<string, Snapshot[]>();
  for (const s of all) {
    const list = byCountry.get(s.country) ?? [];
    list.push(s);
    byCountry.set(s.country, list);
  }

  const now = Date.now();
  const windowMs = LABEL_WINDOW_DAYS * 86_400_000;
  const examples: LabeledExample[] = [];

  for (const snapshots of byCountry.values()) {
    const sorted = [...snapshots].sort((a, b) => a.snapshotAt.getTime() - b.snapshotAt.getTime());
    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i];
      const windowEndMs = s.snapshotAt.getTime() + windowMs;
      let jumped = false;
      for (let j = i + 1; j < sorted.length; j++) {
        const laterMs = sorted[j].snapshotAt.getTime();
        if (laterMs > windowEndMs) break; // sorted ascending — nothing further can qualify
        if (sorted[j].threatLevel >= s.threatLevel + ESCALATION_THRESHOLD) {
          jumped = true;
          break;
        }
      }

      const features = [s.threatLevel, s.score, s.momentum, s.momentumDirection, s.eventCount];
      if (jumped) {
        examples.push({ country: s.country, snapshotAt: s.snapshotAt, features, label: 1 });
      } else if (windowEndMs <= now) {
        examples.push({ country: s.country, snapshotAt: s.snapshotAt, features, label: 0 });
      }
      // else: window still pending — correctly excluded, not a negative.
    }
  }

  return examples;
}

async function fetchAllSnapshots(): Promise<Snapshot[]> {
  const db = getDb();
  const rows = await db
    .select({
      country: countryStateHistory.country,
      snapshotAt: countryStateHistory.snapshotAt,
      score: countryStateHistory.score,
      threatLevel: countryStateHistory.threatLevel,
      momentum: countryStateHistory.momentum,
      momentumDirection: countryStateHistory.momentumDirection,
      eventCount: countryStateHistory.eventCount,
    })
    .from(countryStateHistory)
    .orderBy(countryStateHistory.country, countryStateHistory.snapshotAt);
  return rows;
}

export interface TrainResult {
  runId: number;
  sampleSize: number;
  positiveCount: number;
  trained: boolean;
  promoted: boolean;
  predictionsGenerated: number;
  notes: string;
}

export async function trainAndShadowPredict(): Promise<TrainResult> {
  const db = getDb();
  const allSnapshots = await fetchAllSnapshots();
  const examples = buildLabeledExamples(allSnapshots);
  const positiveCount = examples.filter((e) => e.label === 1).length;

  if (examples.length < MIN_TRAINING_SAMPLE) {
    const notes = `insufficient data: ${examples.length} labeled example(s) available (need ${MIN_TRAINING_SAMPLE}+) — country_state_history needs more time before any snapshot's 14-day forward window has resolved.`;
    const [row] = await db
      .insert(riskModelRuns)
      .values({
        sampleSize: examples.length,
        positiveCount,
        backtestSampleSize: 0,
        promoted: false,
        notes,
      })
      .returning({ id: riskModelRuns.id });
    return {
      runId: row.id,
      sampleSize: examples.length,
      positiveCount,
      trained: false,
      promoted: false,
      predictionsGenerated: 0,
      notes,
    };
  }

  // Time-based split, not random — a random split would leak future
  // information into training, defeating the point of backtesting a
  // forecasting task. Train on the older 80%, test on the newest 20%.
  const sortedByTime = [...examples].sort(
    (a, b) => a.snapshotAt.getTime() - b.snapshotAt.getTime(),
  );
  const splitIndex = Math.floor(sortedByTime.length * (1 - TEST_SPLIT_FRACTION));
  const trainSet = sortedByTime.slice(0, splitIndex);
  const testSet = sortedByTime.slice(splitIndex);

  const model: LogisticRegressionModel = trainLogisticRegression(
    trainSet.map((e) => e.features),
    trainSet.map((e) => e.label),
    DEFAULT_TRAIN_CONFIG,
  );

  const backtest =
    testSet.length > 0
      ? evaluateBacktest(
          model,
          testSet.map((e) => e.features),
          testSet.map((e) => e.label),
        )
      : { sampleSize: 0, accuracy: 0, precision: null, recall: null };

  // Promotion — still shadow-only (nothing reads this as "show to users"
  // in this build). Requires a real backtest sample AND both precision
  // and recall to beat the naive "always predict the majority class"
  // baseline, not just a nonzero accuracy (accuracy alone is trivially
  // gameable on an imbalanced label like this one).
  const positiveRate = trainSet.filter((e) => e.label === 1).length / trainSet.length;
  const promoted =
    backtest.sampleSize >= PROMOTION_MIN_BACKTEST_SAMPLE &&
    backtest.precision !== null &&
    backtest.recall !== null &&
    backtest.precision > positiveRate &&
    backtest.recall > 0;

  const notes = `trained on ${trainSet.length} examples (${positiveCount} positive overall), backtested on ${backtest.sampleSize} held-out examples.${promoted ? " Promoted: beats naive baseline on held-out precision/recall." : " Not promoted: " + (backtest.sampleSize < PROMOTION_MIN_BACKTEST_SAMPLE ? `backtest sample (${backtest.sampleSize}) below the ${PROMOTION_MIN_BACKTEST_SAMPLE}-example floor.` : "doesn't yet beat the naive majority-class baseline.")}`;

  const [run] = await db
    .insert(riskModelRuns)
    .values({
      sampleSize: examples.length,
      positiveCount,
      features: JSON.stringify(FEATURE_NAMES),
      coefficients: JSON.stringify(model.weights.concat(model.bias)),
      featureMeans: JSON.stringify(model.featureMeans),
      featureStdDevs: JSON.stringify(model.featureStdDevs),
      backtestSampleSize: backtest.sampleSize,
      backtestAccuracy: backtest.accuracy,
      backtestPrecision: backtest.precision,
      backtestRecall: backtest.recall,
      promoted,
      notes,
    })
    .returning({ id: riskModelRuns.id });

  // Shadow predictions — one per country, generated from each country's
  // MOST RECENT snapshot, logged regardless of whether this run was
  // promoted (the whole point is accumulating a genuinely out-of-sample,
  // prospectively-graded track record — grading a shadow prediction from
  // an unpromoted run is exactly how a future run earns promotion).
  const latestByCountry = new Map<string, Snapshot>();
  for (const s of allSnapshots) {
    const existing = latestByCountry.get(s.country);
    if (!existing || s.snapshotAt > existing.snapshotAt) latestByCountry.set(s.country, s);
  }

  const generatedAt = new Date();
  const resolvesAt = new Date(generatedAt.getTime() + LABEL_WINDOW_DAYS * 86_400_000);
  const predictionRows = [...latestByCountry.values()].map((s) => {
    const features = [s.threatLevel, s.score, s.momentum, s.momentumDirection, s.eventCount];
    return {
      generatedAt,
      modelRunId: run.id,
      country: s.country,
      predictedProbability: predictProbability(model, features),
      inputFeatures: JSON.stringify(features),
      resolvesAt,
    };
  });

  let predictionsGenerated = 0;
  if (predictionRows.length > 0) {
    const inserted = await db
      .insert(riskPredictions)
      .values(predictionRows)
      .returning({ id: riskPredictions.id });
    predictionsGenerated = inserted.length;
  }

  return {
    runId: run.id,
    sampleSize: examples.length,
    positiveCount,
    trained: true,
    promoted,
    predictionsGenerated,
    notes,
  };
}

// Reused by riskModelGrading.ts — same label logic as training, not
// reimplemented, so "was this prediction right" and "was this training
// example positive" can never quietly drift apart.
export function didEscalate(
  startThreatLevel: number,
  laterSnapshots: { threatLevel: number }[],
): boolean {
  return laterSnapshots.some((s) => s.threatLevel >= startThreatLevel + ESCALATION_THRESHOLD);
}

export async function getLatestModelRun(): Promise<{ id: number; promoted: boolean } | null> {
  const db = getDb();
  const [row] = await db
    .select({ id: riskModelRuns.id, promoted: riskModelRuns.promoted })
    .from(riskModelRuns)
    .orderBy(desc(riskModelRuns.trainedAt))
    .limit(1);
  return row ?? null;
}
