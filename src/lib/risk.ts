import { sql, getTableColumns, and, eq, isNull, isNotNull, inArray, desc, type SQL, type AnyColumn } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "@/db";
import { EXPOSURE_WEIGHTING_ENABLED, exposureMultiplierSqlExpr } from "@/lib/exposure";
import { corroborationMultiplierSqlExpr, saturateSensorWeight, sensorSourceList } from "@/lib/scoringMethod";
import { events, type EventRow } from "@/db/schema";
import { pillarForCategory, PILLAR_LIST, PILLAR_WEIGHT, COVERED_PILLARS, type PillarId } from "@/lib/pillars";
import type { Category } from "@/lib/categories";
import {
  weightToThreatLevel,
  computeMomentum,
  blendMomentum,
  escalateThreatLevel,
  THREAT_LABELS,
  type ThreatLevel,
  type Momentum,
  type MomentumDirection,
} from "@/lib/threat";
import { classifyConfidence, type ConfidenceTier } from "@/lib/correlation";
import { ALPHA2_TO_ALPHA3 } from "@/lib/iso3";

// Half-life for the decay: a severity-5 event contributes half its weight
// to a country's score after this many days, and is effectively negligible
// after ~10 half-lives.
const HALF_LIFE_DAYS = 3;
const LOOKBACK_DAYS = 30;
const DECAY_RATE = Math.LN2 / HALF_LIFE_DAYS;

// Resolved once at module load: the exposure curve as SQL, or a literal
// 1 when the model is switched off, so the query shape never changes and
// the off state provably multiplies by exactly one. Table-qualified
// because the scoring query below joins events to itself.
const EXPOSURE_FACTOR_SQL = EXPOSURE_WEIGHTING_ENABLED
  ? exposureMultiplierSqlExpr(`"events"."population_exposed"`, `"events"."category"`)
  : "1";

const CORROBORATION_FACTOR_SQL = corroborationMultiplierSqlExpr(`"corroboration"."sources"`);

// Visible to the scoring engine: approved at the gate, not hidden by the
// kill switch. One definition for the scored row, its primary and its
// duplicates alike.
function scoreable(table: { reviewStatus: AnyColumn; preKillSwitchAt: AnyColumn }): SQL {
  return sql`${table.reviewStatus} = 'approved' and ${table.preKillSwitchAt} is null`;
}

export interface CountryCategoryRow {
  country: string;
  category: string;
  // Set only for the automated detection feeds in scoringMethod.ts's
  // SENSOR_SOURCES, so their load can be saturated per instrument; null
  // for everything else, which is summed as-is.
  sensorSource: string | null;
  decayedWeight: number;
  recent24h: number;
  prior24h: number;
  recent7d: number;
  prior7d: number;
  eventCount: number;
  lastEventAt: string;
}

// One query, grouped by (country, category, sensor) — everything
// downstream (pillar rollups, Threat Level, Momentum) is pure JS
// aggregation over these rows, so the scoring model lives in one place
// (src/lib/threat.ts + src/lib/scoringMethod.ts) rather than being
// re-derived in SQL.
//
// What is counted is a STORY, not an article (scoring version 3 — see
// scoringMethod.ts). A row eventDedup.ts filed as a duplicate of another
// scoreable row adds nothing itself; the story it duplicates is instead
// multiplied by a bounded bonus for the number of distinct sources that
// carried it. A duplicate whose primary was rejected or kill-switched is
// "orphaned" and stands in for the story — but only the earliest such
// orphan per primary, so a rejected primary's echoes cannot re-enter the
// score as several separate stories.
export async function getCountryCategoryRows(country?: string): Promise<CountryCategoryRow[]> {
  const db = getDb();
  const primary = alias(events, "primary_event");
  const sibling = alias(events, "sibling_event");
  const duplicate = alias(events, "duplicate_event");

  const corroboration = db
    .select({
      primaryId: sql<number>`${duplicate.primaryEventId}`.as("primary_id"),
      sources: sql<number>`count(distinct ${duplicate.source})`.as("sources"),
    })
    .from(duplicate)
    .where(and(isNotNull(duplicate.primaryEventId), scoreable(duplicate)))
    .groupBy(duplicate.primaryEventId)
    .as("corroboration");

  const countryFilter = country ? sql`and ${events.country} = ${country.toUpperCase()}` : sql``;
  const sensorKey = sql<string | null>`case when ${events.source} in (${sql.raw(sensorSourceList())}) then ${events.source} end`;
  const decay = sql`exp(-${sql.raw(String(DECAY_RATE))} * extract(epoch from (now() - ${events.publishedAt})) / 86400)`;

  const rows = await db
    .select({
      country: events.country,
      category: events.category,
      sensorSource: sensorKey,
      // Severity, decayed by age, scaled by how many people live where it
      // happened (hazards only — exposure.ts) and by how many independent
      // sources carried the story (scoringMethod.ts).
      decayedWeight: sql<number>`sum(${events.severity} * ${decay} * ${sql.raw(EXPOSURE_FACTOR_SQL)} * ${sql.raw(CORROBORATION_FACTOR_SQL)})`,
      recent24h: sql<number>`sum(case when ${events.publishedAt} > now() - interval '24 hours' then ${events.severity} else 0 end)`,
      prior24h: sql<number>`sum(case when ${events.publishedAt} <= now() - interval '24 hours' and ${events.publishedAt} > now() - interval '48 hours' then ${events.severity} else 0 end)`,
      recent7d: sql<number>`sum(case when ${events.publishedAt} > now() - interval '7 days' then ${events.severity} else 0 end)`,
      prior7d: sql<number>`sum(case when ${events.publishedAt} <= now() - interval '7 days' and ${events.publishedAt} > now() - interval '14 days' then ${events.severity} else 0 end)`,
      eventCount: sql<number>`count(*)`,
      lastEventAt: sql<string>`max(${events.publishedAt})`,
    })
    .from(events)
    .leftJoin(corroboration, eq(corroboration.primaryId, events.id))
    .leftJoin(primary, eq(primary.id, events.primaryEventId))
    .where(
      sql`${events.country} is not null and ${scoreable(events)} and ${events.publishedAt} > now() - interval '${sql.raw(String(LOOKBACK_DAYS))} days' ${countryFilter}
        and (
          ${events.primaryEventId} is null
          or (
            (${primary.id} is null or not (${scoreable(primary)}))
            and not exists (
              select 1 from ${events} ${sql.raw(`"sibling_event"`)}
              where ${sibling.primaryEventId} = ${events.primaryEventId}
                and ${sibling.id} < ${events.id}
                and ${scoreable(sibling)}
            )
          )
        )`,
    )
    .groupBy(events.country, events.category, sensorKey);

  return rows
    .filter((r): r is typeof r & { country: string } => r.country !== null)
    .map((r) => ({
      country: r.country,
      category: r.category,
      sensorSource: r.sensorSource ?? null,
      decayedWeight: Number(r.decayedWeight),
      recent24h: Number(r.recent24h),
      prior24h: Number(r.prior24h),
      recent7d: Number(r.recent7d),
      prior7d: Number(r.prior7d),
      eventCount: Number(r.eventCount),
      lastEventAt: r.lastEventAt,
    }));
}

export interface PillarAgg {
  decayedWeight: number;
  recent24h: number;
  prior24h: number;
  recent7d: number;
  prior7d: number;
  eventCount: number;
  lastEventAt: string;
}

function emptyAgg(): PillarAgg {
  return {
    decayedWeight: 0,
    recent24h: 0,
    prior24h: 0,
    recent7d: 0,
    prior7d: 0,
    eventCount: 0,
    lastEventAt: "",
  };
}

// Groups the flat (country, category) rows into country -> pillar -> agg,
// summing every category that rolls up into the same pillar.
export function aggregateByCountryAndPillar(
  rows: CountryCategoryRow[],
): Map<string, Map<PillarId, PillarAgg>> {
  const byCountry = new Map<string, Map<PillarId, PillarAgg>>();
  // Raw decayed load per (country, pillar, sensor), saturated only once
  // the whole of an instrument's contribution to that pillar is known —
  // saturating each category separately would let a sensor that spans
  // two categories of the same pillar exceed the cap.
  const sensorLoad = new Map<string, { country: string; pillarId: PillarId; raw: number }>();

  for (const row of rows) {
    const pillarId = pillarForCategory(row.category as Category);
    if (!byCountry.has(row.country)) byCountry.set(row.country, new Map());
    const pillars = byCountry.get(row.country)!;
    const agg = pillars.get(pillarId) ?? emptyAgg();

    // Pillar weight applies to the Pulse Level input only — recent/prior
    // (momentum's inputs) are left unweighted since a constant multiplier
    // cancels out of a percentage-change ratio anyway.
    if (row.sensorSource) {
      const key = `${row.country}|${pillarId}|${row.sensorSource}`;
      const load = sensorLoad.get(key) ?? { country: row.country, pillarId, raw: 0 };
      load.raw += row.decayedWeight;
      sensorLoad.set(key, load);
    } else {
      agg.decayedWeight += row.decayedWeight * PILLAR_WEIGHT[pillarId];
    }
    agg.recent24h += row.recent24h;
    agg.prior24h += row.prior24h;
    agg.recent7d += row.recent7d;
    agg.prior7d += row.prior7d;
    agg.eventCount += row.eventCount;
    if (row.lastEventAt > agg.lastEventAt) agg.lastEventAt = row.lastEventAt;

    pillars.set(pillarId, agg);
  }

  for (const { country, pillarId, raw } of sensorLoad.values()) {
    const agg = byCountry.get(country)!.get(pillarId)!;
    agg.decayedWeight += saturateSensorWeight(raw) * PILLAR_WEIGHT[pillarId];
  }

  return byCountry;
}

function pillarMomentum(agg: PillarAgg): Momentum {
  const short = computeMomentum(agg.recent24h, agg.prior24h);
  const long = computeMomentum(agg.recent7d, agg.prior7d);
  return blendMomentum(short, long);
}

export interface CountryThreatSummary {
  country: string;
  // Legacy decayed-weight total — retained as `score` because Globe.tsx's
  // heat-map color gradient is tuned against this exact continuous value.
  score: number;
  eventCount: number;
  lastEventAt: string;
  threatLevel: ThreatLevel;
  threatLabel: string;
  momentum: number;
  momentumDirection: MomentumDirection;
}

export async function getCountryThreatSummaries(): Promise<CountryThreatSummary[]> {
  const rows = await getCountryCategoryRows();
  const byCountry = aggregateByCountryAndPillar(rows);

  const summaries: CountryThreatSummary[] = [];

  for (const [country, pillars] of byCountry) {
    let score = 0;
    let eventCount = 0;
    let lastEventAt = "";
    const pillarLevels: ThreatLevel[] = [];
    let driverLevel: ThreatLevel = 1;
    let driverMomentum: Momentum = { magnitude: 0, direction: 0 };

    for (const agg of pillars.values()) {
      score += agg.decayedWeight;
      eventCount += agg.eventCount;
      if (agg.lastEventAt > lastEventAt) lastEventAt = agg.lastEventAt;

      const level = weightToThreatLevel(agg.decayedWeight);
      pillarLevels.push(level);

      const momentum = pillarMomentum(agg);
      // Overall momentum tracks whichever pillar is driving the country's
      // threat level — a high-magnitude swing in a pillar that's otherwise
      // calm shouldn't dominate the headline number the way the pillar
      // actually pushing the Threat Level should.
      if (
        level > driverLevel ||
        (level === driverLevel && momentum.magnitude > driverMomentum.magnitude)
      ) {
        driverLevel = level;
        driverMomentum = momentum;
      }
    }

    summaries.push({
      country,
      score,
      eventCount,
      lastEventAt,
      threatLevel: escalateThreatLevel(pillarLevels),
      threatLabel: "", // filled in below once we know the level
      momentum: driverMomentum.magnitude,
      momentumDirection: driverMomentum.direction,
    });
  }

  for (const s of summaries) s.threatLabel = THREAT_LABELS[s.threatLevel];

  // A country with zero events in the lookback window is a real, honest
  // "Low" reading, not "we have no idea" — but it still needs to actually
  // appear (Chad, and most of the world most days, would otherwise be
  // silently absent from both the country list and the globe's coverage,
  // which reads as "we don't track this country" rather than "this country
  // is quiet right now"). Every recognized country gets a baseline row;
  // countries with real signal above still sort to the top.
  const covered = new Set(summaries.map((s) => s.country));
  for (const country of Object.keys(ALPHA2_TO_ALPHA3).sort()) {
    if (covered.has(country)) continue;
    summaries.push({
      country,
      score: 0,
      eventCount: 0,
      lastEventAt: "",
      threatLevel: 1,
      threatLabel: THREAT_LABELS[1],
      momentum: 0,
      momentumDirection: 0,
    });
  }

  return summaries.sort((a, b) => b.score - a.score);
}

export interface PillarBreakdownEntry {
  pillarId: PillarId;
  label: string;
  shortLabel: string;
  color: string;
  threatLevel: ThreatLevel;
  threatLabel: string;
  momentum: number;
  momentumDirection: MomentumDirection;
  eventCount: number;
  lastEventAt: string | null;
  covered: boolean;
}

export interface CountryThreatDetail {
  country: string;
  threatLevel: ThreatLevel;
  threatLabel: string;
  momentum: number;
  momentumDirection: MomentumDirection;
  pillars: PillarBreakdownEntry[];
}

export async function getCountryThreatDetail(country: string): Promise<CountryThreatDetail> {
  const iso2 = country.toUpperCase();
  const rows = await getCountryCategoryRows(iso2);
  const byCountry = aggregateByCountryAndPillar(rows);
  const pillarAggs = byCountry.get(iso2) ?? new Map<PillarId, PillarAgg>();

  const pillars: PillarBreakdownEntry[] = PILLAR_LIST.map((def) => {
    const agg = pillarAggs.get(def.id);
    const covered = COVERED_PILLARS.has(def.id);
    const level = agg ? weightToThreatLevel(agg.decayedWeight) : 1;
    const momentum = agg ? pillarMomentum(agg) : { magnitude: 0, direction: 0 as MomentumDirection };

    return {
      pillarId: def.id,
      label: def.label,
      shortLabel: def.shortLabel,
      color: def.color,
      threatLevel: level,
      threatLabel: THREAT_LABELS[level],
      momentum: momentum.magnitude,
      momentumDirection: momentum.direction,
      eventCount: agg?.eventCount ?? 0,
      lastEventAt: agg?.lastEventAt || null,
      covered,
    };
  });

  const pillarLevels = pillars.filter((p) => p.covered).map((p) => p.threatLevel);
  const overallLevel = escalateThreatLevel(pillarLevels);

  const driver = pillars
    .filter((p) => p.covered)
    .reduce<PillarBreakdownEntry | null>((best, p) => {
      if (!best) return p;
      if (p.threatLevel > best.threatLevel) return p;
      if (p.threatLevel === best.threatLevel && p.momentum > best.momentum) return p;
      return best;
    }, null);

  return {
    country: iso2,
    threatLevel: overallLevel,
    threatLabel: THREAT_LABELS[overallLevel],
    momentum: driver?.momentum ?? 0,
    momentumDirection: driver?.momentumDirection ?? 0,
    pillars,
  };
}

// Full event rows (map coordinates included) for a country's Feed view.
// Deliberately separate from getCountryRiskEvents below, which returns a
// lighter shape for the Risk tab's list — this one matches GeoEvent so the
// same FeedPanel/AlertToast components used for the live stream can render
// it without a shape adapter. The client-side event stream only ever holds
// the most recent ~100 rows across ALL countries combined (see
// api/events/feed/route.ts's INITIAL_LIMIT), so filtering that buffer
// by country — the previous approach — silently came up empty for any
// country whose events had aged out of that shared window. This queries
// the DB directly instead, scoped to one country.
//
// Only primaries (primary_event_id IS NULL) — cross-outlet duplicates (see
// src/lib/eventDedup.ts) are hidden from the feed and surfaced only via
// GET /api/events/duplicates when a card with sourceCount > 0 is expanded.
export async function getEventsByCountry(
  country: string,
): Promise<(EventRow & { sourceCount: number })[]> {
  const db = getDb();
  const iso2 = country.toUpperCase();
  return db
    .select({
      ...getTableColumns(events),
      sourceCount: sql<number>`(select count(*) from ${events} e2 where e2.primary_event_id = ${events.id} and e2.review_status = 'approved' and e2.pre_kill_switch_at is null)`,
    })
    .from(events)
    .where(
      sql`${events.country} = ${iso2} and ${events.reviewStatus} = 'approved' and ${events.preKillSwitchAt} is null and ${events.publishedAt} > now() - interval '${sql.raw(String(LOOKBACK_DAYS))} days' and ${events.primaryEventId} is null`,
    )
    .orderBy(sql`${events.publishedAt} desc`)
    .limit(100);
}

// Same DB-scoped-instead-of-buffer-filtered fix as getEventsByCountry
// above, for the category "layers" (political-instability, humanitarian,
// etc.) — 2026-09-08 user report: isolating one of the thinner layer
// categories on the client showed almost nothing, even though the
// classifier was genuinely producing and approving real events for them.
// Root cause was the same shape as the pre-existing country bug: the live
// SSE buffer only ever holds the ~100 most recent events GLOBALLY across
// ALL categories, and the 5 flashpoint categories alone comfortably
// exceed 100 events/week (israel-palestine hit this function's own
// 100-row cap on a 7-day query), so a thin category's real ~12 events/week
// gets crowded out of that shared window entirely. Same fix: query the DB
// directly, scoped to the active category set, instead of client-
// filtering the shared buffer.
export async function getEventsByCategories(
  categories: string[],
): Promise<(EventRow & { sourceCount: number })[]> {
  const db = getDb();
  return db
    .select({
      ...getTableColumns(events),
      sourceCount: sql<number>`(select count(*) from ${events} e2 where e2.primary_event_id = ${events.id} and e2.review_status = 'approved' and e2.pre_kill_switch_at is null)`,
    })
    .from(events)
    .where(
      and(
        inArray(events.category, categories),
        eq(events.reviewStatus, "approved"),
        isNull(events.primaryEventId),
        isNull(events.preKillSwitchAt),
        sql`${events.publishedAt} > now() - interval '${sql.raw(String(LOOKBACK_DAYS))} days'`,
      ),
    )
    .orderBy(desc(events.publishedAt))
    .limit(100);
}

export interface CountryRiskEvent {
  id: number;
  title: string;
  summary: string;
  url: string;
  source: string;
  category: string;
  severity: number;
  publishedAt: string;
  weight: number;
  correlationGroupId: string | null;
  confidence: ConfidenceTier | null;
  clusterSize: number;
}

export async function getCountryRiskEvents(
  country: string,
): Promise<CountryRiskEvent[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: events.id,
      title: events.title,
      summary: events.summary,
      url: events.url,
      source: events.source,
      category: events.category,
      severity: events.severity,
      publishedAt: events.publishedAt,
      correlationGroupId: events.correlationGroupId,
      weight: sql<number>`${events.severity} * exp(-${sql.raw(String(DECAY_RATE))} * extract(epoch from (now() - ${events.publishedAt})) / 86400)`,
    })
    .from(events)
    .where(
      sql`${events.country} = ${country.toUpperCase()} and ${events.reviewStatus} = 'approved' and ${events.preKillSwitchAt} is null and ${events.publishedAt} > now() - interval '${sql.raw(String(LOOKBACK_DAYS))} days' and ${events.primaryEventId} is null`,
    )
    .orderBy(sql`${events.publishedAt} desc`)
    .limit(50);

  // Confidence is computed from this same 50-row page's source diversity
  // per cluster — see src/lib/correlation.ts. A cluster's true size can be
  // larger than what's visible on this page, but the ladder only needs
  // "more than one independent source," not an exact count, to move a
  // tier.
  const sourcesByCluster = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.correlationGroupId) continue;
    const list = sourcesByCluster.get(r.correlationGroupId) ?? [];
    list.push(r.source);
    sourcesByCluster.set(r.correlationGroupId, list);
  }

  return rows.map((r) => {
    const clusterSources = r.correlationGroupId
      ? (sourcesByCluster.get(r.correlationGroupId) ?? [r.source])
      : [r.source];
    return {
      ...r,
      publishedAt: r.publishedAt.toISOString(),
      weight: Number(r.weight),
      confidence: r.correlationGroupId ? classifyConfidence(clusterSources) : null,
      clusterSize: clusterSources.length,
    };
  });
}
