import { getDb } from "@/db";
import { alerts, alertCountryState, anomalyFindings, events } from "@/db/schema";
import { and, desc, eq, gte, sql, inArray } from "drizzle-orm";
import { getCountryThreatSummaries, getCountryRiskEvents } from "@/lib/risk";
import { type Category } from "@/lib/categories";
import { CATEGORY_PILLAR } from "@/lib/pillars";
import {
  assessAlert,
  shouldSuppress,
  tierRank,
  type AlertTier,
  type AlertInputs,
} from "@/lib/alertScoring";

// The alert engine (2026-09-22) — the piece that makes everything else
// reach somebody. This system detects, verifies, corroborates, scores and
// explains, and until now it did all of that and then waited to be looked
// at. An institutional reader with five minutes needs a ranked list of
// what changed, not a feed to read.
//
// Runs after `review-pending`, inside the chained job that already exists,
// so newly approved rows are visible and no new database wake-up is added
// (see docs/ARCHITECTURE.md §12).
//
// The unit is a COUNTRY SITUATION, not an article. One alert says
// "Country X changed, here is what changed and here is the evidence",
// anchored to the events that drove it. Alerting per article would
// reproduce the feed with a louder voice, which is the problem, not the
// fix.

// Only the driving events inside this window are considered for severity,
// corroboration and evidence. Matches the "recent" half of the momentum
// engine's short horizon.
const DRIVER_WINDOW_HOURS = 24;

// How far back to count prior alerts when working out a country's
// cooldown step.
const COOLDOWN_WINDOW_HOURS = 24;

const EVIDENCE_LIMIT = 4;

// How long fired alerts are kept.
const ALERT_RETENTION_DAYS = 180;

// "telegram:presstv" and "telegram:rybar" are two channels of one
// family for corroboration purposes only if you squint — they are
// genuinely separate outlets, so the family is the part before the colon
// ONLY for aggregator-style prefixes where the suffix is a query rather
// than a publisher. In practice this app's source strings are either a
// bare outlet ("reuters") or "<platform>:<outlet>", and the outlet is the
// independent voice. Counting "gdelt" once regardless of how many
// articles it contributed is the important part: an aggregator echoing
// itself is not corroboration.
function sourceFamily(source: string): string {
  const s = source.toLowerCase();
  if (s.startsWith("gdelt")) return "gdelt";
  return s;
}

export interface AlertEvaluationResult {
  evaluated: number;
  fired: number;
  suppressed: number;
  byTier: Record<string, number>;
  errors: string[];
}

interface CountryInputs extends AlertInputs {
  country: string;
  evidence: { id: number; title: string; url: string; source: string; severity: number }[];
}

// Everything the scorer needs for every country, gathered in four queries
// rather than four per country — this runs against ~200 countries and the
// database is on a free plan with a compute budget.
async function gatherInputs(): Promise<CountryInputs[]> {
  const db = getDb();
  const summaries = await getCountryThreatSummaries();
  if (summaries.length === 0) return [];
  const countries = summaries.map((s) => s.country);

  const priorRows = await db
    .select({
      country: alertCountryState.country,
      level: alertCountryState.level,
      momentum: alertCountryState.momentum,
      anomalySignals: alertCountryState.anomalySignals,
    })
    .from(alertCountryState);
  const prior = new Map(priorRows.map((r) => [r.country, r]));

  // Anomaly signals per country, from the latest scan generation only —
  // the same "MAX(detectedAt)" reading /api/anomalies uses.
  const [latestScan] = await db
    .select({ detectedAt: sql<string | null>`max(${anomalyFindings.detectedAt})` })
    .from(anomalyFindings);
  const anomalyByCountry = new Map<string, Set<string>>();
  if (latestScan?.detectedAt) {
    const findings = await db
      .select({ country: anomalyFindings.country, signalType: anomalyFindings.signalType })
      .from(anomalyFindings)
      .where(eq(anomalyFindings.detectedAt, new Date(latestScan.detectedAt)));
    for (const f of findings) {
      const set = anomalyByCountry.get(f.country) ?? new Set<string>();
      set.add(f.signalType);
      anomalyByCountry.set(f.country, set);
    }
  }

  // Driving events in the window, for every country at once.
  const since = new Date(Date.now() - DRIVER_WINDOW_HOURS * 60 * 60_000);
  const driverRows = await db
    .select({
      id: events.id,
      country: events.country,
      title: events.title,
      url: events.url,
      source: events.source,
      category: events.category,
      severity: events.severity,
      publishedAt: events.publishedAt,
    })
    .from(events)
    .where(
      and(
        inArray(events.country, countries),
        eq(events.reviewStatus, "approved"),
        sql`${events.primaryEventId} is null`,
        sql`${events.preKillSwitchAt} is null`,
        gte(events.publishedAt, since),
      ),
    )
    .orderBy(desc(events.severity), desc(events.publishedAt));

  const driversByCountry = new Map<string, typeof driverRows>();
  for (const r of driverRows) {
    if (!r.country) continue;
    const list = driversByCountry.get(r.country) ?? [];
    list.push(r);
    driversByCountry.set(r.country, list);
  }

  return summaries.map((s) => {
    const drivers = driversByCountry.get(s.country) ?? [];
    const previous = prior.get(s.country);
    const families = new Set(drivers.map((d) => sourceFamily(d.source)));
    const pillars = new Set(
      drivers.map((d) => CATEGORY_PILLAR[d.category as Category]).filter(Boolean),
    );
    return {
      country: s.country,
      level: s.threatLevel,
      // A country with no stored state is being seen for the first time.
      // Treating that as a rise from 1 would announce every country in the
      // world on the first run; treat it as "no change" and let the next
      // evaluation be the first that can detect movement.
      previousLevel: previous?.level ?? s.threatLevel,
      momentum: s.momentum,
      previousMomentum: previous?.momentum ?? s.momentum,
      maxSeverity: drivers.reduce((m, d) => Math.max(m, d.severity), 0),
      sourceFamilies: families.size,
      anomalySignals: anomalyByCountry.get(s.country)?.size ?? 0,
      previousAnomalySignals: previous?.anomalySignals ?? (anomalyByCountry.get(s.country)?.size ?? 0),
      pillarsActive: pillars.size,
      evidence: drivers.slice(0, EVIDENCE_LIMIT).map((d) => ({
        id: d.id,
        title: d.title,
        url: d.url,
        source: d.source,
        severity: d.severity,
      })),
    };
  });
}

// Same mechanism CountryRiskPanel.tsx already uses to turn an ISO2 code
// into a readable name, rather than a second hand-maintained table that
// could disagree with what the UI shows.
const regionNames =
  typeof Intl !== "undefined" && "DisplayNames" in Intl
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

function displayCountry(code: string): string {
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

function headlineFor(input: CountryInputs, tier: AlertTier): string {
  const name = displayCountry(input.country);
  const levelRise = input.level - input.previousLevel;
  if (levelRise > 0) {
    return `${name}: risk level ${input.previousLevel} to ${input.level}`;
  }
  const momentumRise = input.momentum - input.previousMomentum;
  if (momentumRise >= 25) {
    return `${name}: momentum ${input.previousMomentum} to ${input.momentum} at level ${input.level}`;
  }
  if (input.anomalySignals > 0) {
    return `${name}: level ${input.level}, ${input.anomalySignals} unusual signal${input.anomalySignals === 1 ? "" : "s"}`;
  }
  return `${name}: ${tier.toLowerCase()} at level ${input.level}`;
}

export async function runAlertEvaluation(): Promise<AlertEvaluationResult> {
  const db = getDb();
  const errors: string[] = [];
  const byTier: Record<string, number> = {};
  let fired = 0;
  let suppressed = 0;

  let inputs: CountryInputs[];
  try {
    inputs = await gatherInputs();
  } catch (err) {
    return { evaluated: 0, fired: 0, suppressed: 0, byTier, errors: [`gather: ${err}`] };
  }

  const cooldownSince = new Date(Date.now() - COOLDOWN_WINDOW_HOURS * 60 * 60_000);
  const recentAlerts = await db
    .select({
      country: alerts.country,
      tier: alerts.tier,
      firedAt: alerts.firedAt,
      suppressedReason: alerts.suppressedReason,
    })
    .from(alerts)
    .where(gte(alerts.firedAt, cooldownSince))
    .orderBy(desc(alerts.firedAt));
  const recentByCountry = new Map<string, typeof recentAlerts>();
  for (const a of recentAlerts) {
    const list = recentByCountry.get(a.country) ?? [];
    list.push(a);
    recentByCountry.set(a.country, list);
  }

  const toInsert: (typeof alerts.$inferInsert)[] = [];
  for (const input of inputs) {
    const assessment = assessAlert(input);
    if (!assessment.tier) continue;

    // Only alerts that actually went out count toward the cooldown step;
    // a suppressed row must not make the next one wait even longer.
    const priorSent = (recentByCountry.get(input.country) ?? []).filter((a) => !a.suppressedReason);
    const last = priorSent[0];
    const hoursSince = last ? (Date.now() - last.firedAt.getTime()) / 3_600_000 : null;
    const suppression = shouldSuppress(
      assessment.tier,
      (last?.tier as AlertTier | undefined) ?? null,
      hoursSince,
      priorSent.length,
    );

    if (suppression.suppressed) suppressed++;
    else {
      fired++;
      byTier[assessment.tier] = (byTier[assessment.tier] ?? 0) + 1;
    }

    toInsert.push({
      tier: assessment.tier,
      country: input.country,
      score: assessment.score,
      headline: headlineFor(input, assessment.tier),
      level: input.level,
      previousLevel: input.previousLevel,
      momentum: input.momentum,
      previousMomentum: input.previousMomentum,
      maxSeverity: input.maxSeverity,
      sourceFamilies: input.sourceFamilies,
      anomalySignals: input.anomalySignals,
      pillarsActive: input.pillarsActive,
      components: JSON.stringify(assessment.components),
      evidence: JSON.stringify(input.evidence),
      suppressedReason: suppression.reason,
    });
  }

  const CHUNK = 200;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    try {
      await db.insert(alerts).values(toInsert.slice(i, i + CHUNK));
    } catch (err) {
      errors.push(`insert: ${err}`);
    }
  }

  // Record what we saw, so the next run has a "since when". Written for
  // EVERY country evaluated, not just the ones that alerted — otherwise a
  // country that drifted 1 to 2 quietly would, on some later run, appear
  // to have jumped from 1 in one step.
  for (let i = 0; i < inputs.length; i += CHUNK) {
    const batch = inputs.slice(i, i + CHUNK).map((s) => ({
      country: s.country,
      level: s.level,
      momentum: s.momentum,
      anomalySignals: s.anomalySignals,
      evaluatedAt: new Date(),
    }));
    try {
      await db
        .insert(alertCountryState)
        .values(batch)
        .onConflictDoUpdate({
          target: alertCountryState.country,
          set: {
            level: sql`excluded.level`,
            momentum: sql`excluded.momentum`,
            anomalySignals: sql`excluded.anomaly_signals`,
            evaluatedAt: sql`excluded.evaluated_at`,
          },
        });
    } catch (err) {
      errors.push(`state: ${err}`);
    }
  }

  // Bounded, like every other table added on this budget. Six months is
  // long enough to audit a season's alerting and to measure precision
  // once outcomes are known; keeping them forever would make this the
  // fastest-growing table in the database for no reader.
  try {
    await db
      .delete(alerts)
      .where(sql`${alerts.firedAt} < now() - interval '${sql.raw(String(ALERT_RETENTION_DAYS))} days'`);
  } catch (err) {
    errors.push(`prune: ${err}`);
  }

  return { evaluated: inputs.length, fired, suppressed, byTier, errors };
}

export interface AlertView {
  id: number;
  firedAt: string;
  tier: string;
  country: string;
  headline: string;
  score: number;
  level: number;
  previousLevel: number;
  momentum: number;
  previousMomentum: number;
  anomalySignals: number;
  sourceFamilies: number;
  components: { name: string; points: number; detail: string }[];
  evidence: { id: number; title: string; url: string; source: string; severity: number }[];
}

const FEED_WINDOW_HOURS = 72;

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// Suppressed rows are excluded here: they exist for tuning and audit, not
// to be read as alerts that went out.
export async function getRecentAlerts(limit = 50): Promise<AlertView[]> {
  const db = getDb();
  const since = new Date(Date.now() - FEED_WINDOW_HOURS * 60 * 60_000);
  const rows = await db
    .select()
    .from(alerts)
    .where(and(gte(alerts.firedAt, since), sql`${alerts.suppressedReason} is null`))
    .orderBy(desc(alerts.firedAt), desc(alerts.score))
    .limit(limit);

  return rows
    .map((r) => ({
      id: r.id,
      firedAt: r.firedAt.toISOString(),
      tier: r.tier,
      country: r.country,
      headline: r.headline,
      score: r.score,
      level: r.level,
      previousLevel: r.previousLevel,
      momentum: r.momentum,
      previousMomentum: r.previousMomentum,
      anomalySignals: r.anomalySignals,
      sourceFamilies: r.sourceFamilies,
      components: parseJson(r.components, [] as AlertView["components"]),
      evidence: parseJson(r.evidence, [] as AlertView["evidence"]),
    }))
    .sort((a, b) => {
      const byTier = tierRank(b.tier as AlertTier) - tierRank(a.tier as AlertTier);
      return byTier !== 0 ? byTier : b.firedAt.localeCompare(a.firedAt);
    });
}

// Kept for the country panel: the alerts behind one country, newest first.
export async function getCountryAlerts(country: string, limit = 10): Promise<AlertView[]> {
  const all = await getRecentAlerts(200);
  return all.filter((a) => a.country === country.toUpperCase()).slice(0, limit);
}

export { getCountryRiskEvents };
