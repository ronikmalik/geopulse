import { and, desc, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { classificationArchive, events, gateReviewSamples } from "@/db/schema";
import { STRUCTURAL_SOURCES } from "./structuralSources";

// The pre-publish gate's ground-truth channel (2026-09-20). See
// gateReviewSamples's doc comment in schema.ts for why this exists: every
// other feedback path in the calibration loop is Gemini judging Gemini,
// which can only measure self-agreement. This is the one place a human
// verdict enters the system, and it is deliberately tiny — SAMPLE_PER_DAY
// rows a day, gradable in a minute or two on /admin/gate-review — because
// a channel nobody has time to use is no channel at all.
//
// Stratified: half of each day's sample is drawn from approvals, half from
// rejections. The gate rejects ~45-50% of classified items, so an
// unstratified sample would still be fine, but stratifying guarantees
// both error directions (false publish / false suppress) get measured
// every single day even on a quiet one.
export const SAMPLE_PER_DAY = 10;
const SAMPLE_WINDOW_HOURS = 24;

export interface SampleResult {
  sampled: number;
  approved: number;
  rejected: number;
}

// Called once a day (from the audit-classifier job). Idempotent: an event
// is never sampled twice (unique event_id), and re-running on the same day
// just tops the sample up to SAMPLE_PER_DAY if an earlier run drew fewer.
export async function sampleGateDecisions(): Promise<SampleResult> {
  const db = getDb();
  const perSide = Math.ceil(SAMPLE_PER_DAY / 2);

  const alreadyToday = await db
    .select({ decision: gateReviewSamples.gateDecision, n: sql<number>`count(*)` })
    .from(gateReviewSamples)
    .where(sql`${gateReviewSamples.sampledAt} > now() - interval '${sql.raw(String(SAMPLE_WINDOW_HOURS))} hours'`)
    .groupBy(gateReviewSamples.gateDecision);
  const have = { approved: 0, rejected: 0 };
  for (const r of alreadyToday) if (r.decision === "approved" || r.decision === "rejected") have[r.decision] = Number(r.n);

  const result: SampleResult = { sampled: 0, approved: 0, rejected: 0 };
  for (const decision of ["approved", "rejected"] as const) {
    const need = perSide - have[decision];
    if (need <= 0) continue;
    // Only rows the GATE decided (classified sources) — direct/structural
    // sources (usgs/eonet/...) are approved without review and would just
    // pad the sample with trivially-correct rows. order by random() is fine
    // at this scale (a few hundred rows per day per side).
    const rows = await db
      .select({
        id: events.id,
        source: events.source,
        url: events.url,
        title: events.title,
        summary: events.summary,
        country: events.country,
        category: events.category,
        severity: events.severity,
        reviewReasoning: events.reviewReasoning,
      })
      .from(events)
      .where(
        sql`${events.reviewStatus} = ${decision}
          and ${events.createdAt} > now() - interval '${sql.raw(String(SAMPLE_WINDOW_HOURS))} hours'
          and ${events.source} not in (${sql.join(STRUCTURAL_SOURCES.map((s) => sql`${s}`), sql`, `)})
          and not exists (select 1 from ${gateReviewSamples} g where g.event_id = ${events.id})`,
      )
      .orderBy(sql`random()`)
      .limit(need);
    if (rows.length === 0) continue;
    const inserted = await db
      .insert(gateReviewSamples)
      .values(
        rows.map((r) => ({
          eventId: r.id,
          gateDecision: decision,
          gateReasoning: r.reviewReasoning,
          source: r.source,
          url: r.url,
          title: r.title,
          summary: r.summary,
          country: r.country,
          category: r.category,
          severity: r.severity,
        })),
      )
      .onConflictDoNothing({ target: gateReviewSamples.eventId })
      .returning({ id: gateReviewSamples.id });
    result.sampled += inserted.length;
    result[decision] += inserted.length;
  }
  return result;
}

export interface GateSample {
  id: number;
  eventId: number;
  sampledAt: string;
  gateDecision: string;
  gateReasoning: string | null;
  source: string;
  url: string;
  title: string;
  summary: string;
  country: string | null;
  category: string;
  severity: number;
}

export async function getPendingGateSamples(limit = 50): Promise<GateSample[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(gateReviewSamples)
    .where(isNull(gateReviewSamples.humanVerdict))
    .orderBy(desc(gateReviewSamples.sampledAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    eventId: r.eventId,
    sampledAt: r.sampledAt.toISOString(),
    gateDecision: r.gateDecision,
    gateReasoning: r.gateReasoning,
    source: r.source,
    url: r.url,
    title: r.title,
    summary: r.summary,
    country: r.country,
    category: r.category,
    severity: r.severity,
  }));
}

export type HumanVerdict = "correct" | "wrong";

export interface GradeResult {
  found: boolean;
  flipped: boolean;
  note: string;
}

// Records the human verdict and, when the gate was wrong, reverses the
// live decision: a wrongly-rejected item is published, a wrongly-approved
// one is hidden (soft — reviewStatus only, same as every other reversal
// in this codebase). The archive label is updated to match so the shadow
// k-NN classifier trains on the corrected label. Grading is idempotent
// per sample (a re-grade overwrites the verdict; the flip only happens on
// the transition into "wrong" from ungraded/correct, never twice).
export async function gradeGateSample(id: number, verdict: HumanVerdict, note: string | null): Promise<GradeResult> {
  const db = getDb();
  const [sample] = await db.select().from(gateReviewSamples).where(eq(gateReviewSamples.id, id)).limit(1);
  if (!sample) return { found: false, flipped: false, note: "not found" };

  const previouslyWrong = sample.humanVerdict === "wrong";
  await db
    .update(gateReviewSamples)
    .set({ humanVerdict: verdict, humanNote: note, gradedAt: new Date() })
    .where(eq(gateReviewSamples.id, id));

  if (verdict !== "wrong" || previouslyWrong) {
    return { found: true, flipped: false, note: verdict === "wrong" ? "already flipped on a previous grade" : "recorded" };
  }

  const newStatus = sample.gateDecision === "approved" ? "rejected" : "approved";
  const flipped = await db
    .update(events)
    .set({ reviewStatus: newStatus, reviewReasoning: `human grade: gate was wrong${note ? ` - ${note.slice(0, 300)}` : ""}` })
    .where(and(eq(events.id, sample.eventId), eq(events.reviewStatus, sample.gateDecision)))
    .returning({ id: events.id });
  await db
    .update(classificationArchive)
    .set({ kept: newStatus === "approved" })
    .where(eq(classificationArchive.url, sample.url));

  return flipped.length > 0
    ? { found: true, flipped: true, note: `event ${sample.eventId} ${newStatus === "approved" ? "published" : "hidden"}` }
    : { found: true, flipped: false, note: "verdict recorded; the event had already changed state since sampling" };
}

export interface GateMetrics {
  graded: number;
  pending: number;
  // Of the gate's approvals a human graded, how many were right
  // (1 - false-publish rate).
  approvalPrecision: number | null;
  // Of the gate's rejections a human graded, how many were right
  // (1 - false-suppress rate).
  rejectionPrecision: number | null;
  overallAccuracy: number | null;
  windowDays: number;
}

export async function getGateMetrics(windowDays = 30): Promise<GateMetrics> {
  const db = getDb();
  const rows = await db
    .select({ decision: gateReviewSamples.gateDecision, verdict: gateReviewSamples.humanVerdict, n: sql<number>`count(*)` })
    .from(gateReviewSamples)
    .where(and(isNotNull(gateReviewSamples.gradedAt), sql`${gateReviewSamples.gradedAt} > now() - interval '${sql.raw(String(windowDays))} days'`))
    .groupBy(gateReviewSamples.gateDecision, gateReviewSamples.humanVerdict);
  const [{ pending }] = await db
    .select({ pending: sql<number>`count(*)` })
    .from(gateReviewSamples)
    .where(isNull(gateReviewSamples.humanVerdict));

  const count = (decision: string, verdict: string) => Number(rows.find((r) => r.decision === decision && r.verdict === verdict)?.n ?? 0);
  const aOk = count("approved", "correct");
  const aBad = count("approved", "wrong");
  const rOk = count("rejected", "correct");
  const rBad = count("rejected", "wrong");
  const graded = aOk + aBad + rOk + rBad;
  const ratio = (ok: number, bad: number) => (ok + bad > 0 ? ok / (ok + bad) : null);
  return {
    graded,
    pending: Number(pending),
    approvalPrecision: ratio(aOk, aBad),
    rejectionPrecision: ratio(rOk, rBad),
    overallAccuracy: ratio(aOk + rOk, aBad + rBad),
    windowDays,
  };
}

// Human-labelled evaluation rows for the shadow k-NN classifier
// (textClassifierTraining.ts): the label is what a person said the RIGHT
// decision was, derived from the gate's decision and the grade.
export interface HumanLabelledExample {
  url: string;
  relevant: boolean; // what the human said the right decision was
  gateCorrect: boolean; // whether the live gate got this row right — the baseline a shadow model must beat
}

export async function getHumanLabelledExamples(): Promise<HumanLabelledExample[]> {
  const db = getDb();
  const rows = await db
    .select({ url: gateReviewSamples.url, decision: gateReviewSamples.gateDecision, verdict: gateReviewSamples.humanVerdict })
    .from(gateReviewSamples)
    .where(isNotNull(gateReviewSamples.humanVerdict));
  return rows.map((r) => ({
    url: r.url,
    relevant: (r.decision === "approved") === (r.verdict === "correct"),
    gateCorrect: r.verdict === "correct",
  }));
}

// Weekly fail-loud check (2026-09-20). Every model gated on human ground
// truth — the shadow text classifier, gate precision/recall, and the
// active-learning sampler the ML roadmap plans — is only as good as the
// grades that exist, and for the first week of this channel that number
// was zero. This is not a metric; it is an alarm. It returns the counts
// and THROWS when a week passed with ungraded samples piling up and no
// grade landing, so the GitHub Actions job that calls it goes red and
// GitHub emails the repo owner. A run with nothing to grade is fine.
export interface GradingCheckResult {
  gradedLast7d: number;
  gradedTotal: number;
  ungraded: number;
  oldestUngradedDays: number | null;
}

export async function checkGradingProgress(): Promise<GradingCheckResult> {
  const db = getDb();
  const [row] = await db
    .select({
      gradedLast7d: sql<number>`count(*) filter (where ${gateReviewSamples.gradedAt} > now() - interval '7 days')::int`,
      gradedTotal: sql<number>`count(${gateReviewSamples.gradedAt})::int`,
      ungraded: sql<number>`count(*) filter (where ${gateReviewSamples.humanVerdict} is null)::int`,
      oldestUngradedDays: sql<number | null>`extract(epoch from (now() - min(${gateReviewSamples.sampledAt}) filter (where ${gateReviewSamples.humanVerdict} is null))) / 86400`,
    })
    .from(gateReviewSamples);
  const result: GradingCheckResult = {
    gradedLast7d: Number(row.gradedLast7d),
    gradedTotal: Number(row.gradedTotal),
    ungraded: Number(row.ungraded),
    oldestUngradedDays: row.oldestUngradedDays === null ? null : Number(Number(row.oldestUngradedDays).toFixed(1)),
  };
  if (result.gradedLast7d === 0 && result.ungraded > 0) {
    throw new Error(
      `No gate-review grades in the last 7 days while ${result.ungraded} samples wait (oldest ${result.oldestUngradedDays} days). ` +
        `Grade them at /admin/gate-review - the shadow classifier cannot be evaluated, let alone promoted, until at least 50 exist (currently ${result.gradedTotal}).`,
    );
  }
  return result;
}
