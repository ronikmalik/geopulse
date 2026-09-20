import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { feedArchive, narrativeNoveltyFindings } from "@/db/schema";
import { detectAnomaly, DEFAULT_BASELINE_CONFIG, type AnomalyOutcome } from "@/lib/anomalyBaseline";

// Narrative-novelty anomaly signal (2026-09-20). narrative_novelty_findings
// has scored every embedded article against the learned cluster map since
// 2026-09-13 — 6,000+ rows — and until now nothing read them. This turns
// them into the sixth signal of the daily anomaly scan: "the share of this
// country's articles that match NO known narrative jumped today."
//
// The value is the NOVEL SHARE (0-100, percent of the country's scored
// articles in a 24h bucket whose nearest cluster was further than that
// cluster's own novelty threshold), not the raw mean distance. Reason: the
// cluster map is retrained weekly, and raw distances shift with every
// retrain, so a distance series is not stationary across a Sunday. Each
// cluster's threshold is calibrated to its own spread at training time,
// which makes the novel/matched verdict roughly comparable across
// generations — the share is the series that survives a retrain.
//
// Buckets are rolling 24h windows over the article's PUBLISHED time,
// relative to scan time — the same shape as eventVolumeAnomaly.ts, for
// the same partial-day reason. A bucket with fewer than MIN_ITEMS_PER_DAY
// scored articles is dropped entirely (a share of 1/1 is not a signal);
// if today is dropped, detectAnomaly's own staleness check reports
// "stale" rather than comparing yesterday to the baseline as if it were
// today.
//
// minAbsoluteJump is 25 percentage points — the default of 2 is sized for
// counts, not a share; 25 means "at least a quarter of the day's coverage
// moved from familiar to unfamiliar," which is the smallest change a
// reader would call a new story rather than noise. Rises only: a drop in
// novelty is coverage settling into a known narrative, not an alert.

const LOOKBACK_DAYS = 30;
const MIN_ITEMS_PER_DAY = 3;
const MIN_ABSOLUTE_JUMP_PCT = 25;

interface BucketRow {
  country: string;
  daysAgo: number;
  items: number;
  novel: number;
}

async function fetchBuckets(): Promise<BucketRow[]> {
  const db = getDb();
  const daysAgoExpr = sql<number>`floor(extract(epoch from (now() - ${feedArchive.publishedAt})) / 86400)::int`;
  const rows = await db
    .select({
      country: feedArchive.country,
      daysAgo: daysAgoExpr,
      items: sql<number>`count(*)::int`,
      novel: sql<number>`count(*) filter (where ${narrativeNoveltyFindings.outcome} = 'novel')::int`,
    })
    .from(narrativeNoveltyFindings)
    .innerJoin(feedArchive, sql`${feedArchive.id} = ${narrativeNoveltyFindings.feedArchiveId}`)
    .where(
      sql`${feedArchive.country} is not null and ${feedArchive.publishedAt} > now() - interval '${sql.raw(String(LOOKBACK_DAYS + 1))} days'`,
    )
    .groupBy(feedArchive.country, daysAgoExpr);
  return rows
    .filter((r): r is typeof r & { country: string } => r.country !== null)
    .map((r) => ({ country: r.country, daysAgo: Number(r.daysAgo), items: Number(r.items), novel: Number(r.novel) }));
}

export interface NarrativeNoveltyAnomalyOutcome {
  country: string;
  outcome: AnomalyOutcome;
}

export async function getNarrativeNoveltyAnomalyOutcomes(): Promise<NarrativeNoveltyAnomalyOutcome[]> {
  const rows = await fetchBuckets();
  const now = Date.now();
  const byCountry = new Map<string, { value: number; at: Date }[]>();
  for (const r of rows) {
    if (r.items < MIN_ITEMS_PER_DAY) continue;
    const series = byCountry.get(r.country) ?? [];
    series.push({ value: Math.round((100 * r.novel) / r.items), at: new Date(now - r.daysAgo * 86_400_000) });
    byCountry.set(r.country, series);
  }
  const outcomes: NarrativeNoveltyAnomalyOutcome[] = [];
  for (const [country, series] of byCountry) {
    series.sort((a, b) => b.at.getTime() - a.at.getTime());
    outcomes.push({
      country,
      outcome: detectAnomaly(series, {
        ...DEFAULT_BASELINE_CONFIG,
        lookbackDays: LOOKBACK_DAYS,
        minAbsoluteJump: MIN_ABSOLUTE_JUMP_PCT,
      }),
    });
  }
  return outcomes;
}
