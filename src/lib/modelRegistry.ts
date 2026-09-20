import { desc, sql, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { modelRegistry, riskPredictions, riskModelRuns, type NewModelRegistryRow } from "@/db/schema";
import { getGateMetrics } from "@/lib/gateReview";

// The model registry (ML roadmap phase 1, 2026-09-20). Every trainer calls
// recordModelRun() after writing its own family table; /api/models reads
// getModelRegistrySummary(). See modelRegistry's doc comment in schema.ts.
//
// The rule this enforces at the reading end: a model is shown next to the
// naive alternative it had to beat, on the same held-out rows, or it is
// not shown as a model at all. "Promoted" here is copied from the family
// table's own gate — this file never decides promotion, it only reports it.

export interface ModelRunEntry {
  family: string;
  variant: string;
  sampleSize: number;
  backtestSampleSize?: number;
  featureNames?: string[];
  metrics: Record<string, number | string | boolean | null>;
  baseline?: Record<string, number | string | boolean | null>;
  trained?: boolean;
  promoted?: boolean;
  notes?: string;
  sourceTable?: string;
  sourceId?: number;
}

// Best-effort by design: the family table is the source of truth, and a
// trainer that already succeeded must not be reported as failed because
// the summary row didn't land. Logged, never thrown.
export async function recordModelRun(entry: ModelRunEntry): Promise<void> {
  try {
    const row: NewModelRegistryRow = {
      family: entry.family,
      variant: entry.variant,
      sampleSize: entry.sampleSize,
      backtestSampleSize: entry.backtestSampleSize ?? 0,
      featureNames: entry.featureNames ? JSON.stringify(entry.featureNames) : null,
      metrics: JSON.stringify(entry.metrics),
      baseline: entry.baseline ? JSON.stringify(entry.baseline) : null,
      trained: entry.trained ?? true,
      promoted: entry.promoted ?? false,
      notes: entry.notes ?? null,
      sourceTable: entry.sourceTable ?? null,
      sourceId: entry.sourceId ?? null,
    };
    await getDb().insert(modelRegistry).values(row);
  } catch (err) {
    console.error(`model registry write failed (${entry.family}/${entry.variant}): ${err}`);
  }
}

export interface ModelSummaryEntry {
  family: string;
  variant: string;
  trainedAt: string;
  trained: boolean;
  promoted: boolean;
  sampleSize: number;
  backtestSampleSize: number;
  featureNames: string[] | null;
  metrics: Record<string, unknown>;
  baseline: Record<string, unknown> | null;
  notes: string | null;
  runsRecorded: number;
}

export interface LiveHorizonTrack {
  horizonDays: number;
  modelType: string;
  predictions: number;
  graded: number;
  liveMae: number | null;
  // Persistence on the SAME graded predictions: |today's score − actual|,
  // reconstructed from the stored input feature vector (index 1 = score,
  // see FEATURE_NAMES in riskModel.ts).
  livePersistenceMae: number | null;
}

export interface ModelRegistrySummary {
  generatedAt: string;
  models: ModelSummaryEntry[];
  liveTrack: LiveHorizonTrack[];
  gate: Awaited<ReturnType<typeof getGateMetrics>>;
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// Latest run per (family, variant), plus how many runs that pair has
// recorded — the page shows the current state, the count says how long
// the model has been tracked.
async function latestPerVariant(): Promise<ModelSummaryEntry[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(modelRegistry)
    .orderBy(desc(modelRegistry.trainedAt), desc(modelRegistry.id));
  const seen = new Map<string, ModelSummaryEntry>();
  for (const r of rows) {
    const key = `${r.family}::${r.variant}`;
    const existing = seen.get(key);
    if (existing) {
      existing.runsRecorded += 1;
      continue;
    }
    seen.set(key, {
      family: r.family,
      variant: r.variant,
      trainedAt: r.trainedAt.toISOString(),
      trained: r.trained,
      promoted: r.promoted,
      sampleSize: r.sampleSize,
      backtestSampleSize: r.backtestSampleSize,
      featureNames: parseJson<string[]>(r.featureNames),
      metrics: parseJson<Record<string, unknown>>(r.metrics) ?? {},
      baseline: parseJson<Record<string, unknown>>(r.baseline),
      notes: r.notes,
      runsRecorded: 1,
    });
  }
  return [...seen.values()].sort((a, b) => a.family.localeCompare(b.family) || a.variant.localeCompare(b.variant));
}

// The live, out-of-sample track record: predictions made before their
// outcome was knowable, graded once it resolved (riskModelGrading.ts).
// Stronger evidence than any backtest, and the number a promotion should
// eventually hinge on.
async function liveTrackRecord(): Promise<LiveHorizonTrack[]> {
  const db = getDb();
  const rows = await db
    .select({
      horizonDays: riskModelRuns.horizonDays,
      modelType: riskModelRuns.modelType,
      predictions: sql<number>`count(*)::int`,
      graded: sql<number>`count(${riskPredictions.gradedAt})::int`,
      liveMae: sql<number | null>`avg(${riskPredictions.absoluteError})`,
      livePersistenceMae: sql<number | null>`avg(abs((${riskPredictions.inputFeatures}::jsonb ->> 1)::float - ${riskPredictions.actualScore})) filter (where ${riskPredictions.actualScore} is not null)`,
    })
    .from(riskPredictions)
    .innerJoin(riskModelRuns, eq(riskModelRuns.id, riskPredictions.modelRunId))
    .groupBy(riskModelRuns.horizonDays, riskModelRuns.modelType)
    .orderBy(riskModelRuns.horizonDays, riskModelRuns.modelType);
  return rows.map((r) => ({
    horizonDays: r.horizonDays,
    modelType: r.modelType,
    predictions: Number(r.predictions),
    graded: Number(r.graded),
    liveMae: r.liveMae === null ? null : Number(Number(r.liveMae).toFixed(3)),
    livePersistenceMae: r.livePersistenceMae === null ? null : Number(Number(r.livePersistenceMae).toFixed(3)),
  }));
}

export async function getModelRegistrySummary(): Promise<ModelRegistrySummary> {
  const [models, liveTrack, gate] = await Promise.all([latestPerVariant(), liveTrackRecord(), getGateMetrics(30)]);
  return { generatedAt: new Date().toISOString(), models, liveTrack, gate };
}

