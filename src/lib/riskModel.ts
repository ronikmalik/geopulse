import { and, desc, eq, gte } from "drizzle-orm";
import { getDb } from "@/db";
import { countryStateHistory, anomalyFindings, riskModelRuns, riskPredictions } from "@/db/schema";
import {
  trainLinearRegression,
  evaluateRegressionBacktest,
  predict,
  DEFAULT_TRAIN_CONFIG,
} from "@/lib/linearRegression";
import {
  trainGradientBoostedTrees,
  evaluateGbmBacktest,
  predictGbm,
  DEFAULT_GBM_CONFIG,
} from "@/lib/gradientBoostedTrees";
import { weightToThreatLevel } from "@/lib/threat";

// Project 4 (2026-09-09) — the two model types trainHorizon fits and
// compares for every horizon, champion/challenger-style (see
// riskModelRuns.modelType's own doc comment in schema.ts).
type ModelType = "linear-regression" | "gradient-boosted-trees";
const MODEL_TYPES: ModelType[] = ["linear-regression", "gradient-boosted-trees"];

// Shadow-mode predictive risk model (2026-09-09, redesigned same day per
// user request: predicts a country's actual future score over several
// horizons, not a binary escalation flag). See this session's plan file
// for the full reasoning behind every constant below — several of them
// exist specifically because a live-verified bug or an explicit
// don't-cut-corners instruction demanded them, not because more
// mechanism is inherently better.
export const PREDICTION_HORIZONS_DAYS = [1, 2, 3, 5, 7, 10, 14];

// Hard cutoff, not computed from the table — deliberately discards this
// app's launch week in one stroke. Verified live 2026-09-09: Russia's
// threatLevel went 2->4 between its literal first two daily snapshots,
// the decayed-weight score still climbing from an artificial "no history
// yet" cold start toward its real steady-state value, not a genuine
// escalation. Every candidate before this is excluded outright.
// Exported for countryStateMultivariateAnomaly.ts (Project 2) — same
// reasoning applies there: the launch week's cold-start artifact is a data
// problem, not something specific to score-forecasting, so both models
// share the identical cutoff rather than each picking their own.
export const TRAINING_DATA_START = new Date("2026-09-09T00:00:00Z");

// On top of the hard cutoff above — the deeper root cause is more general
// than "the app's first week was messy": ANY country's own first
// appearance in country_state_history can show the identical cold-start
// climb, whenever that happens (a currently-quiet country that starts
// being tracked for the first time next month gets the same artifact).
// Exclude each country's own candidates within this many days of ITS OWN
// earliest post-cutoff snapshot, not just the table's global one. 7 days
// is ~2x risk.ts's own HALF_LIFE_DAYS=3 — the same decay constant already
// governing how long a country's score takes to reflect its real
// recent-event picture, reused here rather than a second guessed number.
const BURN_IN_DAYS = 7;

// How close a snapshot needs to be to a target time (a candidate's
// snapshotAt + horizon) to count as "the" observation at that horizon.
// Tight relative to the shortest (1-day) horizon in scope — daily-cron
// jitter in practice is much smaller than this, and it's still generous
// enough to absorb a genuinely late cron without risking a match against
// the wrong day.
const MATCH_TOLERANCE_MS = 6 * 60 * 60_000;

const ANOMALY_WINDOW_DAYS = 7;

// Exported for src/lib/countryStateMultivariateAnomaly.ts (Project 2, added
// 2026-09-09) — that module needs this exact feature vector (minus
// threatLevel, which it deliberately drops — see its own comment on why:
// threatLevel is a step function of score per threat.ts's own
// weightToThreatLevel, near-collinear with it, which would make a
// covariance matrix ill-conditioned) so the two models can never quietly
// define "a country's feature vector" two different ways.
export const FEATURE_NAMES = [
  "threatLevel",
  "score",
  "momentum",
  "momentumDirection",
  "eventCount",
  "anomalyCount7d",
];
const SCORE_FEATURE_INDEX = FEATURE_NAMES.indexOf("score");

const TEST_SPLIT_FRACTION = 0.2;
// Below this, don't even attempt a fit — a handful of points isn't a
// model, it's noise with extra steps. Deliberately much lower than the
// promotion floor: this gate is "is there anything to learn from at
// all," promotion is "has it actually been validated."
const MIN_TRAINING_SAMPLE = 10;
const PROMOTION_MIN_BACKTEST_SAMPLE = 30;

// Exported for countryStateMultivariateAnomaly.ts — same "one shared
// definition of a country's feature vector" reasoning as FEATURE_NAMES
// above.
export interface Snapshot {
  country: string;
  snapshotAt: Date;
  score: number;
  threatLevel: number;
  momentum: number;
  momentumDirection: number;
  eventCount: number;
}

export interface AnomalyRow {
  country: string;
  detectedAt: Date;
}

export async function fetchSnapshotsSince(start: Date): Promise<Snapshot[]> {
  const db = getDb();
  return db
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
    .where(gte(countryStateHistory.snapshotAt, start))
    .orderBy(countryStateHistory.country, countryStateHistory.snapshotAt);
}

export async function fetchAnomaliesSince(start: Date): Promise<AnomalyRow[]> {
  const db = getDb();
  return db
    .select({ country: anomalyFindings.country, detectedAt: anomalyFindings.detectedAt })
    .from(anomalyFindings)
    .where(gte(anomalyFindings.detectedAt, start));
}

function countAnomaliesInWindow(
  anomalies: AnomalyRow[],
  country: string,
  asOfMs: number,
  windowMs: number,
): number {
  let count = 0;
  for (const a of anomalies) {
    if (a.country !== country) continue;
    const t = a.detectedAt.getTime();
    if (t <= asOfMs && t > asOfMs - windowMs) count++;
  }
  return count;
}

// Exported for countryStateMultivariateAnomaly.ts — see FEATURE_NAMES's own
// comment for why sharing this one implementation matters.
export function featuresFor(s: Snapshot, anomalies: AnomalyRow[]): number[] {
  const anomalyCount7d = countAnomaliesInWindow(
    anomalies,
    s.country,
    s.snapshotAt.getTime(),
    ANOMALY_WINDOW_DAYS * 86_400_000,
  );
  return [s.threatLevel, s.score, s.momentum, s.momentumDirection, s.eventCount, anomalyCount7d];
}

// Closest snapshot to `targetMs` within tolerance, or null. `sorted` must
// be ascending by snapshotAt (every caller already has it that way).
// Generic (not hardcoded to the full Snapshot shape) so riskModelGrading.ts
// can reuse the EXACT SAME matching logic training uses against whatever
// narrower row shape its own query happens to select — "how training
// matched a target" and "how grading matches an outcome" can never
// quietly drift apart if there's only one implementation.
export function findClosestSnapshot<T extends { snapshotAt: Date }>(
  sorted: T[],
  targetMs: number,
): T | null {
  let best: T | null = null;
  let bestDiff = Infinity;
  for (const s of sorted) {
    const diff = Math.abs(s.snapshotAt.getTime() - targetMs);
    if (diff > MATCH_TOLERANCE_MS) continue;
    if (diff < bestDiff) {
      best = s;
      bestDiff = diff;
    }
  }
  return best;
}

export interface RegressionExample {
  country: string;
  snapshotAt: Date;
  features: number[]; // FEATURE_NAMES order
  targetScore: number;
}

// Groups snapshots by country, sorted ascending, filtered to each
// country's own snapshots at-or-after its OWN burn-in cutoff (that
// country's earliest snapshot + BURN_IN_DAYS) — see BURN_IN_DAYS's own doc
// comment for why this has to be per-country, not just a single global
// cutoff. Extracted 2026-09-09 (previously inline in buildRegressionExamples
// below) so countryStateMultivariateAnomaly.ts (Project 2) can reuse the
// EXACT SAME burn-in exclusion instead of a second, possibly-drifting copy
// of it — a country's cold-start artifact is the same underlying data
// problem for both models, not something each should decide separately.
// Safe to search only the post-burn-in subset for findClosestSnapshot's
// target lookups too (not just as the candidate pool): any valid horizon
// target time is source_time + horizonMs where source_time is already
// past burn-in, and horizonMs (>= 1 day) always exceeds MATCH_TOLERANCE_MS
// (6h) by a wide margin, so a pre-burn-in snapshot could never actually be
// the closest match to any such target anyway — filtering them out of the
// search pool changes nothing observable, verified by this exact reasoning
// before extracting, not just assumed.
export function groupByCountryPastBurnIn(allSnapshots: Snapshot[]): Map<string, Snapshot[]> {
  const byCountry = new Map<string, Snapshot[]>();
  for (const s of allSnapshots) {
    const list = byCountry.get(s.country) ?? [];
    list.push(s);
    byCountry.set(s.country, list);
  }

  const burnInMs = BURN_IN_DAYS * 86_400_000;
  const result = new Map<string, Snapshot[]>();
  for (const [country, snapshots] of byCountry) {
    const sorted = [...snapshots].sort((a, b) => a.snapshotAt.getTime() - b.snapshotAt.getTime());
    const effectiveStartMs = sorted[0].snapshotAt.getTime();
    const burnInCutoffMs = effectiveStartMs + burnInMs;
    const pastBurnIn = sorted.filter((s) => s.snapshotAt.getTime() >= burnInCutoffMs);
    if (pastBurnIn.length > 0) result.set(country, pastBurnIn);
  }
  return result;
}

// The part that has to be exactly right. For candidate S and horizon H:
// find the same country's snapshot closest to S.snapshotAt + H days,
// within MATCH_TOLERANCE_MS. No match (horizon not yet resolved, or a
// genuine data gap) excludes the candidate for THIS horizon only — never
// fabricated as "no change," which would invent a target that was never
// actually observed.
export function buildRegressionExamples(
  allSnapshots: Snapshot[],
  anomalies: AnomalyRow[],
  horizonDays: number,
): RegressionExample[] {
  const byCountry = groupByCountryPastBurnIn(allSnapshots);
  const horizonMs = horizonDays * 86_400_000;
  const examples: RegressionExample[] = [];

  for (const sorted of byCountry.values()) {
    for (const s of sorted) {
      const target = findClosestSnapshot(sorted, s.snapshotAt.getTime() + horizonMs);
      if (!target) continue; // window unresolved, or a real data gap — excluded, not fabricated

      examples.push({
        country: s.country,
        snapshotAt: s.snapshotAt,
        features: featuresFor(s, anomalies),
        targetScore: target.score,
      });
    }
  }

  return examples;
}

export interface HorizonTrainResult {
  horizonDays: number;
  modelType: ModelType;
  runId: number;
  sampleSize: number;
  trained: boolean;
  promoted: boolean;
  predictionsGenerated: number;
  notes: string;
}

// Fits ONE model type against an already-built, already-time-split
// train/test set, backtests it, records the run, and generates shadow
// predictions from it. Called once per entry in MODEL_TYPES for every
// horizon — trainHorizon below builds the shared examples/split exactly
// once and calls this twice, so both model types are always compared on
// literally identical data, never a coincidentally-different sample.
async function fitAndRecordModel(
  modelType: ModelType,
  horizonDays: number,
  trainSet: RegressionExample[],
  testSet: RegressionExample[],
  allSnapshots: Snapshot[],
  anomalies: AnomalyRow[],
): Promise<HorizonTrainResult> {
  const db = getDb();
  const trainX = trainSet.map((e) => e.features);
  const trainY = trainSet.map((e) => e.targetScore);
  const testX = testSet.map((e) => e.features);
  const testY = testSet.map((e) => e.targetScore);
  const naivePredictions = testSet.map((e) => e.features[SCORE_FEATURE_INDEX]); // naive: "no change" from today's score

  let modelParams: unknown;
  let selectedL2: number | null = null;
  let backtest: { sampleSize: number; mae: number; rmse: number; naiveMae: number };
  let predictOne: (features: number[]) => number;
  let hyperparamNote: string;

  if (modelType === "linear-regression") {
    const { model, selectedL2: l2 } = trainLinearRegression(trainX, trainY, DEFAULT_TRAIN_CONFIG);
    modelParams = model;
    selectedL2 = l2;
    backtest = evaluateRegressionBacktest(model, testX, testY, naivePredictions);
    predictOne = (features) => predict(model, features);
    hyperparamNote = `L2=${l2}`;
  } else {
    const { model, selectedNEstimators, selectedMaxDepth } = trainGradientBoostedTrees(trainX, trainY, DEFAULT_GBM_CONFIG);
    modelParams = model;
    backtest = evaluateGbmBacktest(model, testX, testY, naivePredictions);
    predictOne = (features) => predictGbm(model, features);
    hyperparamNote = `nEstimators=${selectedNEstimators}, maxDepth=${selectedMaxDepth}`;
  }

  const promoted = backtest.sampleSize >= PROMOTION_MIN_BACKTEST_SAMPLE && backtest.mae < backtest.naiveMae;

  const notes = `[${modelType}, ${hyperparamNote}] trained on ${trainSet.length} examples, backtested on ${backtest.sampleSize} held-out examples (MAE ${backtest.mae.toFixed(2)} vs. naive-persistence MAE ${backtest.naiveMae.toFixed(2)}).${
    promoted
      ? " Promoted: beats naive persistence baseline on held-out MAE."
      : " Not promoted: " +
        (backtest.sampleSize < PROMOTION_MIN_BACKTEST_SAMPLE
          ? `backtest sample (${backtest.sampleSize}) below the ${PROMOTION_MIN_BACKTEST_SAMPLE}-example floor.`
          : "doesn't yet beat the naive persistence baseline.")
  }`;

  const [run] = await db
    .insert(riskModelRuns)
    .values({
      modelType,
      horizonDays,
      sampleSize: trainSet.length + testSet.length,
      features: JSON.stringify(FEATURE_NAMES),
      modelParams: JSON.stringify(modelParams),
      selectedL2,
      backtestSampleSize: backtest.sampleSize,
      backtestMae: backtest.mae,
      backtestRmse: backtest.rmse,
      backtestNaiveMae: backtest.naiveMae,
      promoted,
      notes,
    })
    .returning({ id: riskModelRuns.id });

  // Shadow predictions — one per country, from each country's MOST
  // RECENT snapshot, logged regardless of promotion (the whole point is
  // accumulating a genuinely out-of-sample, prospectively-graded track
  // record — grading a shadow prediction from an unpromoted run is
  // exactly how a future run earns promotion).
  const latestByCountry = new Map<string, Snapshot>();
  for (const s of allSnapshots) {
    const existing = latestByCountry.get(s.country);
    if (!existing || s.snapshotAt > existing.snapshotAt) latestByCountry.set(s.country, s);
  }

  const generatedAt = new Date();
  const resolvesAt = new Date(generatedAt.getTime() + horizonDays * 86_400_000);
  const predictionRows = [...latestByCountry.values()].map((s) => {
    const features = featuresFor(s, anomalies);
    const predictedScore = predictOne(features);
    return {
      generatedAt,
      modelRunId: run.id,
      country: s.country,
      predictedScore,
      predictedThreatLevel: weightToThreatLevel(predictedScore),
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
    horizonDays,
    modelType,
    runId: run.id,
    sampleSize: trainSet.length + testSet.length,
    trained: true,
    promoted,
    predictionsGenerated,
    notes,
  };
}

async function trainHorizon(
  horizonDays: number,
  allSnapshots: Snapshot[],
  anomalies: AnomalyRow[],
): Promise<HorizonTrainResult[]> {
  const db = getDb();
  const examples = buildRegressionExamples(allSnapshots, anomalies, horizonDays);

  if (examples.length < MIN_TRAINING_SAMPLE) {
    const notes = `insufficient data: ${examples.length} labeled example(s) available (need ${MIN_TRAINING_SAMPLE}+) for the ${horizonDays}-day horizon.`;
    const results: HorizonTrainResult[] = [];
    for (const modelType of MODEL_TYPES) {
      const [row] = await db
        .insert(riskModelRuns)
        .values({ modelType, horizonDays, sampleSize: examples.length, backtestSampleSize: 0, promoted: false, notes })
        .returning({ id: riskModelRuns.id });
      results.push({
        horizonDays,
        modelType,
        runId: row.id,
        sampleSize: examples.length,
        trained: false,
        promoted: false,
        predictionsGenerated: 0,
        notes,
      });
    }
    return results;
  }

  // Time-based split, not random — a random split would leak future
  // information into training, defeating the point of backtesting a
  // forecasting task. Built ONCE and shared by both model types below —
  // the whole point of a champion/challenger comparison is that neither
  // side gets an easier or different split.
  const sortedByTime = [...examples].sort((a, b) => a.snapshotAt.getTime() - b.snapshotAt.getTime());
  const splitIndex = Math.floor(sortedByTime.length * (1 - TEST_SPLIT_FRACTION));
  const trainSet = sortedByTime.slice(0, splitIndex);
  const testSet = sortedByTime.slice(splitIndex);

  const results: HorizonTrainResult[] = [];
  for (const modelType of MODEL_TYPES) {
    results.push(await fitAndRecordModel(modelType, horizonDays, trainSet, testSet, allSnapshots, anomalies));
  }
  return results;
}

export async function trainAndShadowPredict(): Promise<HorizonTrainResult[]> {
  const [allSnapshots, anomalies] = await Promise.all([
    fetchSnapshotsSince(TRAINING_DATA_START),
    // Anomalies from well before TRAINING_DATA_START are still needed for
    // the 7-day trailing window on candidates right at the cutoff — pull
    // from ANOMALY_WINDOW_DAYS earlier than the cutoff, not the cutoff
    // itself, so the very first eligible candidates still get an
    // accurate anomalyCount7d instead of an artificially-low one.
    fetchAnomaliesSince(new Date(TRAINING_DATA_START.getTime() - ANOMALY_WINDOW_DAYS * 86_400_000)),
  ]);

  const results: HorizonTrainResult[] = [];
  for (const horizonDays of PREDICTION_HORIZONS_DAYS) {
    results.push(...(await trainHorizon(horizonDays, allSnapshots, anomalies)));
  }
  return results;
}

// Champion/challenger selection (Project 4, 2026-09-09): compares the
// latest run of EACH model type for this horizon and serves whichever one
// actually wins — a real, promoted model with the lower backtest MAE, not
// either type hardcoded as "the" answer. If only one type is promoted,
// that one wins by default; if neither is, returns the more recently
// trained one (still useful to know it exists, just not to act on) rather
// than null, so a caller can distinguish "no runs yet" from "runs exist,
// neither has earned promotion."
export async function getLatestModelRun(
  horizonDays: number,
): Promise<{ id: number; modelType: string; promoted: boolean; backtestMae: number | null } | null> {
  const db = getDb();
  const latestPerType: { id: number; modelType: string; promoted: boolean; backtestMae: number | null }[] = [];

  for (const modelType of MODEL_TYPES) {
    const [row] = await db
      .select({
        id: riskModelRuns.id,
        modelType: riskModelRuns.modelType,
        promoted: riskModelRuns.promoted,
        backtestMae: riskModelRuns.backtestMae,
      })
      .from(riskModelRuns)
      .where(and(eq(riskModelRuns.horizonDays, horizonDays), eq(riskModelRuns.modelType, modelType)))
      .orderBy(desc(riskModelRuns.trainedAt))
      .limit(1);
    if (row) latestPerType.push(row);
  }

  if (latestPerType.length === 0) return null;
  const promotedRuns = latestPerType.filter((r) => r.promoted);
  if (promotedRuns.length > 0) {
    return promotedRuns.reduce((best, r) => ((r.backtestMae ?? Infinity) < (best.backtestMae ?? Infinity) ? r : best));
  }
  return latestPerType[0];
}
