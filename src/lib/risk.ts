import { sql, getTableColumns } from "drizzle-orm";
import { getDb } from "@/db";
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

interface CountryCategoryRow {
  country: string;
  category: string;
  decayedWeight: number;
  recent24h: number;
  prior24h: number;
  recent7d: number;
  prior7d: number;
  eventCount: number;
  lastEventAt: string;
}

// One query, grouped by (country, category) — everything downstream
// (pillar rollups, Threat Level, Momentum) is pure JS aggregation over
// these rows, so the scoring model lives in one place (src/lib/threat.ts)
// rather than being re-derived in SQL.
async function getCountryCategoryRows(country?: string): Promise<CountryCategoryRow[]> {
  const db = getDb();
  const countryFilter = country
    ? sql`and ${events.country} = ${country.toUpperCase()}`
    : sql``;
  const rows = await db
    .select({
      country: events.country,
      category: events.category,
      decayedWeight: sql<number>`sum(${events.severity} * exp(-${sql.raw(String(DECAY_RATE))} * extract(epoch from (now() - ${events.publishedAt})) / 86400))`,
      recent24h: sql<number>`sum(case when ${events.publishedAt} > now() - interval '24 hours' then ${events.severity} else 0 end)`,
      prior24h: sql<number>`sum(case when ${events.publishedAt} <= now() - interval '24 hours' and ${events.publishedAt} > now() - interval '48 hours' then ${events.severity} else 0 end)`,
      recent7d: sql<number>`sum(case when ${events.publishedAt} > now() - interval '7 days' then ${events.severity} else 0 end)`,
      prior7d: sql<number>`sum(case when ${events.publishedAt} <= now() - interval '7 days' and ${events.publishedAt} > now() - interval '14 days' then ${events.severity} else 0 end)`,
      eventCount: sql<number>`count(*)`,
      lastEventAt: sql<string>`max(${events.publishedAt})`,
    })
    .from(events)
    .where(
      sql`${events.country} is not null and ${events.publishedAt} > now() - interval '${sql.raw(String(LOOKBACK_DAYS))} days' ${countryFilter}`,
    )
    .groupBy(events.country, events.category);

  return rows
    .filter((r): r is typeof r & { country: string } => r.country !== null)
    .map((r) => ({
      country: r.country,
      category: r.category,
      decayedWeight: Number(r.decayedWeight),
      recent24h: Number(r.recent24h),
      prior24h: Number(r.prior24h),
      recent7d: Number(r.recent7d),
      prior7d: Number(r.prior7d),
      eventCount: Number(r.eventCount),
      lastEventAt: r.lastEventAt,
    }));
}

interface PillarAgg {
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
function aggregateByCountryAndPillar(
  rows: CountryCategoryRow[],
): Map<string, Map<PillarId, PillarAgg>> {
  const byCountry = new Map<string, Map<PillarId, PillarAgg>>();

  for (const row of rows) {
    const pillarId = pillarForCategory(row.category as Category);
    if (!byCountry.has(row.country)) byCountry.set(row.country, new Map());
    const pillars = byCountry.get(row.country)!;
    const agg = pillars.get(pillarId) ?? emptyAgg();

    // Pillar weight applies to the Pulse Level input only — recent/prior
    // (momentum's inputs) are left unweighted since a constant multiplier
    // cancels out of a percentage-change ratio anyway.
    agg.decayedWeight += row.decayedWeight * PILLAR_WEIGHT[pillarId];
    agg.recent24h += row.recent24h;
    agg.prior24h += row.prior24h;
    agg.recent7d += row.recent7d;
    agg.prior7d += row.prior7d;
    agg.eventCount += row.eventCount;
    if (row.lastEventAt > agg.lastEventAt) agg.lastEventAt = row.lastEventAt;

    pillars.set(pillarId, agg);
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
// api/stream/route.ts's INITIAL_BACKFILL_LIMIT), so filtering that buffer
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
      sourceCount: sql<number>`(select count(*) from ${events} e2 where e2.primary_event_id = ${events.id})`,
    })
    .from(events)
    .where(
      sql`${events.country} = ${iso2} and ${events.publishedAt} > now() - interval '${sql.raw(String(LOOKBACK_DAYS))} days' and ${events.primaryEventId} is null`,
    )
    .orderBy(sql`${events.publishedAt} desc`)
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
      sql`${events.country} = ${country.toUpperCase()} and ${events.publishedAt} > now() - interval '${sql.raw(String(LOOKBACK_DAYS))} days' and ${events.primaryEventId} is null`,
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
