import { sql, getTableColumns } from "drizzle-orm";
import { getDb } from "@/db";
import {
  countryFeatureDaily,
  events,
  feedArchive,
  narrativeNoveltyFindings,
  aircraftCountHistory,
  gpsJammingHistory,
  anomalyFindings,
  type NewCountryFeatureDailyRow,
} from "@/db/schema";
import { getCountryThreatSummaries, getCountryCategoryRows, aggregateByCountryAndPillar } from "@/lib/risk";
import type { PillarId } from "@/lib/pillars";

// Writes the wide daily feature snapshot (country_feature_daily — see its
// doc comment in schema.ts for why it exists and why it is upserted).
// Called from the `snapshot` job right after snapshotCountryStates(), and
// deliberately NOT allowed to fail that job: a features failure is logged
// and the narrow history row still lands, never the other way round.
//
// Every number here is either copied from the same summaries the Trends
// tab shows, or a plain aggregate over `events` / the history tables for
// windows ending at snapshot time. Nothing is modelled — this is the
// input table, kept boring on purpose so any model trained on it can be
// audited back to a GROUP BY.

const Z_BASELINE_DAYS = 14;

interface VolumeRow {
  country: string;
  events24h: number;
  events7d: number;
  severityMean24h: number | null;
  severityMax24h: number | null;
  severityMean7d: number | null;
  distinctSources7d: number;
  distinctFamilies7d: number;
  telegram7d: number;
  gdelt7d: number;
}

async function fetchVolumeRows(): Promise<Map<string, VolumeRow>> {
  const db = getDb();
  const in24h = sql`${events.publishedAt} > now() - interval '24 hours'`;
  const rows = await db
    .select({
      country: events.country,
      events24h: sql<number>`count(*) filter (where ${in24h})::int`,
      events7d: sql<number>`count(*)::int`,
      severityMean24h: sql<number | null>`avg(${events.severity}) filter (where ${in24h})`,
      severityMax24h: sql<number | null>`max(${events.severity}) filter (where ${in24h})`,
      severityMean7d: sql<number | null>`avg(${events.severity})`,
      distinctSources7d: sql<number>`count(distinct ${events.source})::int`,
      distinctFamilies7d: sql<number>`count(distinct split_part(${events.source}, ':', 1))::int`,
      telegram7d: sql<number>`count(*) filter (where ${events.source} like 'telegram:%')::int`,
      gdelt7d: sql<number>`count(*) filter (where ${events.source} = 'gdelt')::int`,
    })
    .from(events)
    .where(
      sql`${events.country} is not null and ${events.reviewStatus} = 'approved' and ${events.preKillSwitchAt} is null and ${events.publishedAt} > now() - interval '7 days'`,
    )
    .groupBy(events.country);
  const out = new Map<string, VolumeRow>();
  for (const r of rows) {
    if (!r.country) continue;
    out.set(r.country, {
      country: r.country,
      events24h: Number(r.events24h),
      events7d: Number(r.events7d),
      severityMean24h: r.severityMean24h === null ? null : Number(r.severityMean24h),
      severityMax24h: r.severityMax24h === null ? null : Number(r.severityMax24h),
      severityMean7d: r.severityMean7d === null ? null : Number(r.severityMean7d),
      distinctSources7d: Number(r.distinctSources7d),
      distinctFamilies7d: Number(r.distinctFamilies7d),
      telegram7d: Number(r.telegram7d),
      gdelt7d: Number(r.gdelt7d),
    });
  }
  return out;
}

interface NoveltyRow {
  items: number;
  novelShare: number;
  meanDistance: number;
}

// Novelty is scored on feed_archive rows (the permanent copy), keyed by
// the archive's own country, over articles PUBLISHED in the last 24h —
// not scored in the last 24h, since scoring lags publication by however
// long the embedding backfill takes.
async function fetchNoveltyRows(): Promise<Map<string, NoveltyRow>> {
  const db = getDb();
  const rows = await db
    .select({
      country: feedArchive.country,
      items: sql<number>`count(*)::int`,
      novelShare: sql<number>`avg(case when ${narrativeNoveltyFindings.outcome} = 'novel' then 1.0 else 0.0 end)`,
      meanDistance: sql<number>`avg(${narrativeNoveltyFindings.distance})`,
    })
    .from(narrativeNoveltyFindings)
    .innerJoin(feedArchive, sql`${feedArchive.id} = ${narrativeNoveltyFindings.feedArchiveId}`)
    .where(sql`${feedArchive.country} is not null and ${feedArchive.publishedAt} > now() - interval '24 hours'`)
    .groupBy(feedArchive.country);
  const out = new Map<string, NoveltyRow>();
  for (const r of rows) {
    if (!r.country) continue;
    out.set(r.country, { items: Number(r.items), novelShare: Number(r.novelShare), meanDistance: Number(r.meanDistance) });
  }
  return out;
}

interface SeriesPoint {
  country: string;
  at: Date;
  value: number;
}

// Latest daily value per country plus its z-score against the previous
// Z_BASELINE_DAYS distinct days of the same series. Null z until the
// baseline has 14 samples and a non-zero spread — the same floor
// anomalyBaseline.ts uses, so "z14" here and an anomaly finding there are
// the same arithmetic on the same data.
function latestAndZ(points: SeriesPoint[]): Map<string, { latest: number; z: number | null }> {
  const byCountry = new Map<string, SeriesPoint[]>();
  for (const p of points) {
    const arr = byCountry.get(p.country) ?? [];
    arr.push(p);
    byCountry.set(p.country, arr);
  }
  const out = new Map<string, { latest: number; z: number | null }>();
  for (const [country, arr] of byCountry) {
    arr.sort((a, b) => b.at.getTime() - a.at.getTime());
    // One value per calendar day (latest wins) so a re-run never double-counts a day.
    const perDay = new Map<string, number>();
    for (const p of arr) {
      const day = p.at.toISOString().slice(0, 10);
      if (!perDay.has(day)) perDay.set(day, p.value);
    }
    const daily = [...perDay.values()];
    const latest = daily[0];
    const baseline = daily.slice(1, 1 + Z_BASELINE_DAYS);
    let z: number | null = null;
    if (baseline.length >= Z_BASELINE_DAYS) {
      const mean = baseline.reduce((s, v) => s + v, 0) / baseline.length;
      const variance = baseline.reduce((s, v) => s + (v - mean) ** 2, 0) / baseline.length;
      const sd = Math.sqrt(variance);
      z = sd > 0 ? (latest - mean) / sd : null;
    }
    out.set(country, { latest, z });
  }
  return out;
}

async function fetchAircraftSeries(kind: "military" | "commercial"): Promise<SeriesPoint[]> {
  const db = getDb();
  const rows = await db
    .select({ country: aircraftCountHistory.country, at: aircraftCountHistory.snapshotAt, value: aircraftCountHistory.count })
    .from(aircraftCountHistory)
    .where(
      sql`${aircraftCountHistory.kind} = ${kind} and ${aircraftCountHistory.snapshotAt} > now() - interval '${sql.raw(String(Z_BASELINE_DAYS + 3))} days'`,
    );
  return rows.map((r) => ({ country: r.country, at: r.at, value: Number(r.value) }));
}

async function fetchJammingSeries(): Promise<SeriesPoint[]> {
  const db = getDb();
  const rows = await db
    .select({ country: gpsJammingHistory.country, at: gpsJammingHistory.snapshotAt, value: gpsJammingHistory.badCellCount })
    .from(gpsJammingHistory)
    .where(sql`${gpsJammingHistory.snapshotAt} > now() - interval '${sql.raw(String(Z_BASELINE_DAYS + 3))} days'`);
  return rows.map((r) => ({ country: r.country, at: r.at, value: Number(r.value) }));
}

async function fetchAnomalyRecency(): Promise<Map<string, { daysSince: number; count7d: number }>> {
  const db = getDb();
  const rows = await db
    .select({
      country: anomalyFindings.country,
      daysSince: sql<number>`extract(epoch from (now() - max(${anomalyFindings.detectedAt}))) / 86400`,
      count7d: sql<number>`count(*) filter (where ${anomalyFindings.detectedAt} > now() - interval '7 days')::int`,
    })
    .from(anomalyFindings)
    .groupBy(anomalyFindings.country);
  const out = new Map<string, { daysSince: number; count7d: number }>();
  for (const r of rows) out.set(r.country, { daysSince: Number(r.daysSince), count7d: Number(r.count7d) });
  return out;
}

const PILLAR_COLUMN: Record<PillarId, keyof NewCountryFeatureDailyRow> = {
  "geopolitical-security": "pillarGeopoliticalSecurity",
  "political-governance": "pillarPoliticalGovernance",
  "climate-environment": "pillarClimateEnvironment",
  "natural-biological-hazards": "pillarNaturalBiologicalHazards",
  "human-social": "pillarHumanSocial",
  "infrastructure-connectivity": "pillarInfrastructureConnectivity",
  "supply-chain-resource": "pillarSupplyChainResource",
  "cyber-technology": "pillarCyberTechnology",
};

export interface FeatureSnapshotResult {
  upserted: number;
  snapshotDate: string;
  countriesWithVolume: number;
  countriesWithNovelty: number;
}

const round = (v: number | null, places = 4): number | null =>
  v === null || !Number.isFinite(v) ? null : Number(v.toFixed(places));

export async function snapshotCountryFeatures(): Promise<FeatureSnapshotResult> {
  const db = getDb();
  const snapshotAt = new Date();
  const snapshotDate = snapshotAt.toISOString().slice(0, 10);

  const [summaries, categoryRows, volume, novelty, military, commercial, jamming, anomalies] = await Promise.all([
    getCountryThreatSummaries(),
    getCountryCategoryRows(),
    fetchVolumeRows(),
    fetchNoveltyRows(),
    fetchAircraftSeries("military"),
    fetchAircraftSeries("commercial"),
    fetchJammingSeries(),
    fetchAnomalyRecency(),
  ]);
  const pillarsByCountry = aggregateByCountryAndPillar(categoryRows);
  const militaryZ = latestAndZ(military);
  const commercialZ = latestAndZ(commercial);
  const jammingZ = latestAndZ(jamming);

  const rows: NewCountryFeatureDailyRow[] = summaries.map((s) => {
    const row: NewCountryFeatureDailyRow = {
      country: s.country,
      snapshotDate,
      snapshotAt,
      score: s.score,
      threatLevel: s.threatLevel,
      momentum: s.momentum,
      momentumDirection: s.momentumDirection,
      eventCount: s.eventCount,
    };
    const pillars = pillarsByCountry.get(s.country);
    if (pillars) {
      for (const [pillarId, agg] of pillars) {
        (row as Record<string, unknown>)[PILLAR_COLUMN[pillarId]] = round(agg.decayedWeight) ?? 0;
      }
    }
    const v = volume.get(s.country);
    if (v) {
      row.events24h = v.events24h;
      row.events7d = v.events7d;
      row.severityMean24h = round(v.severityMean24h);
      row.severityMax24h = v.severityMax24h;
      row.severityMean7d = round(v.severityMean7d);
      row.distinctSources7d = v.distinctSources7d;
      row.distinctFamilies7d = v.distinctFamilies7d;
      row.telegramShare7d = v.events7d > 0 ? round(v.telegram7d / v.events7d) : null;
      row.gdeltShare7d = v.events7d > 0 ? round(v.gdelt7d / v.events7d) : null;
    }
    const n = novelty.get(s.country);
    if (n) {
      row.noveltyItems24h = n.items;
      row.novelShare24h = round(n.novelShare);
      row.noveltyMeanDistance24h = round(n.meanDistance);
    }
    const m = militaryZ.get(s.country);
    if (m) {
      row.aircraftMilitaryLatest = m.latest;
      row.aircraftMilitaryZ14 = round(m.z);
    }
    const c = commercialZ.get(s.country);
    if (c) {
      row.aircraftCommercialLatest = c.latest;
      row.aircraftCommercialZ14 = round(c.z);
    }
    const j = jammingZ.get(s.country);
    if (j) {
      row.gpsJammingLatest = j.latest;
      row.gpsJammingZ14 = round(j.z);
    }
    const a = anomalies.get(s.country);
    if (a) {
      row.daysSinceAnomaly = round(a.daysSince, 2);
      row.anomalyCount7d = a.count7d;
    }
    return row;
  });

  if (rows.length === 0) return { upserted: 0, snapshotDate, countriesWithVolume: 0, countriesWithNovelty: 0 };

  // Upsert on (country, snapshot_date): a re-run the same UTC day
  // overwrites with fresher numbers instead of adding a second row.
  const updateSet = Object.fromEntries(
    Object.entries(getTableColumns(countryFeatureDaily))
      .filter(([k]) => k !== "id" && k !== "country" && k !== "snapshotDate")
      .map(([k, col]) => [k, sql.raw(`excluded."${col.name}"`)]),
  );
  let upserted = 0;
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const inserted = await db
      .insert(countryFeatureDaily)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoUpdate({ target: [countryFeatureDaily.country, countryFeatureDaily.snapshotDate], set: updateSet })
      .returning({ id: countryFeatureDaily.id });
    upserted += inserted.length;
  }
  return { upserted, snapshotDate, countriesWithVolume: volume.size, countriesWithNovelty: novelty.size };
}
