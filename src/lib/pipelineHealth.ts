import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { STRUCTURAL_SOURCES } from "./structuralSources";
import { getUsageBudget, MONTHLY_BYTE_CAP } from "./translationUsage";

// Daily alarm for the parts of the pipeline that fail quietly (2026-09-23).
//
// Why it exists: on 2026-09-21 GDELT started losing half its files and
// published-event embeddings started falling ~100 a day behind, and for
// two days every run still reported "success" — each job did exactly
// what it was told, just less of it than the day required. Separately,
// five items sat in review for two days, and the local Gemini key had
// been dead for longer than anyone knew.
//
// This runs right after the 18:00 UTC snapshot, inside the same workflow
// (so the database is already awake — no extra Neon wake-up), and THROWS
// when any check fails: the workflow goes red and GitHub emails the repo
// owner. Every threshold sits well clear of the healthy value measured on
// 2026-09-23, so a failure means something actually changed.

export interface PipelineMetrics {
  // Published events with no embedding yet. Healthy: roughly one cycle's
  // arrivals (~10). It was 267 when the fixed per-cycle batch fell behind.
  feedEmbeddingBacklog: number;
  // Kept classifier-archive rows with no embedding. Must trend to zero
  // (2,675 on 2026-09-23, clearing ~290/day); dropped rows are capped by
  // design and deliberately not counted (classificationArchiveEmbeddingBackfill.ts).
  keptArchiveBacklog: number;
  // Embedding calls recorded today (Pacific day, per ai_usage). Every
  // ingest cycle embeds something, so zero by 18:00 UTC — 11 hours into
  // the Pacific day — means the Gemini key or quota is broken.
  embeddingsToday: number;
  // Events still pending review after this many hours. Review runs ~1 min
  // after each ingest and gives up on an item after 3 unusable verdicts
  // (~1.5 h), so anything older is stuck.
  oldestPendingReviewHours: number | null;
  // GDELT candidates discovered but not yet title-fetched.
  gdeltQueueWaiting: number;
  // Approved, visible events inserted in the last 24 hours, per family.
  events24hBySource: Record<string, number>;
  // Hours since each polled source last succeeded.
  hoursSinceSourceSuccess: Record<string, number>;
  // Google Translate bytes used this month. translate.ts can never exceed
  // MONTHLY_BYTE_CAP, so this is an early warning, not a guard: at the cap,
  // non-English Telegram posts stop being translated until the month turns.
  translationMonthUsed: number;
}

export const HEALTH_LIMITS = {
  feedEmbeddingBacklog: 150,
  keptArchiveBacklog: 3_000,
  minEmbeddingsToday: 1,
  maxPendingReviewHours: 6,
  gdeltQueueWaiting: 2_500,
  // Families that publish every day in any normal news cycle. Hazard
  // feeds (USGS, GDACS, EONET, IODA) are excluded: a quiet day is real.
  mustPublishDaily: ["gdelt", "rss", "telegram"],
  maxHoursSinceSourceSuccess: 6,
  // Measured 2026-09-23: 342k used by the 23rd (~70% of the cap), heading
  // for ~410k. 95% means the month is about to run dry.
  translationShareOfCap: 0.95,
} as const;

// Pure, so the thresholds themselves are testable.
export function evaluatePipelineHealth(m: PipelineMetrics): string[] {
  const L = HEALTH_LIMITS;
  const failures: string[] = [];
  if (m.feedEmbeddingBacklog > L.feedEmbeddingBacklog) {
    failures.push(`${m.feedEmbeddingBacklog} published events have no embedding (limit ${L.feedEmbeddingBacklog}) — the embedding backfill is falling behind.`);
  }
  if (m.keptArchiveBacklog > L.keptArchiveBacklog) {
    failures.push(`${m.keptArchiveBacklog} kept classifier rows have no embedding (limit ${L.keptArchiveBacklog}) — that backlog should only shrink.`);
  }
  if (m.embeddingsToday < L.minEmbeddingsToday) {
    failures.push(`No embedding calls today — check the Gemini key (GitHub secret GEMINI_API_KEY) and quota.`);
  }
  if (m.oldestPendingReviewHours !== null && m.oldestPendingReviewHours > L.maxPendingReviewHours) {
    failures.push(`An event has been pending review for ${m.oldestPendingReviewHours.toFixed(1)} h (limit ${L.maxPendingReviewHours} h) — the review gate is stuck or not running.`);
  }
  if (m.gdeltQueueWaiting > L.gdeltQueueWaiting) {
    failures.push(`${m.gdeltQueueWaiting} GDELT candidates waiting for a title (limit ${L.gdeltQueueWaiting}) — the title drain is not keeping up.`);
  }
  for (const family of L.mustPublishDaily) {
    if ((m.events24hBySource[family] ?? 0) === 0) {
      failures.push(`No ${family} events in the last 24 h.`);
    }
  }
  for (const [source, hours] of Object.entries(m.hoursSinceSourceSuccess)) {
    if (hours > L.maxHoursSinceSourceSuccess) {
      failures.push(`${source} has not fetched successfully for ${hours.toFixed(1)} h (limit ${L.maxHoursSinceSourceSuccess} h).`);
    }
  }
  if (m.translationMonthUsed > L.translationShareOfCap * MONTHLY_BYTE_CAP) {
    failures.push(`Translation at ${m.translationMonthUsed.toLocaleString()} of the ${MONTHLY_BYTE_CAP.toLocaleString()} monthly cap — non-English Telegram posts will soon go untranslated until the month turns. The cap itself cannot be exceeded.`);
  }
  return failures;
}

export async function gatherPipelineMetrics(): Promise<PipelineMetrics> {
  const db = getDb();
  const structural = sql.raw([...STRUCTURAL_SOURCES].map((s) => `'${s}'`).join(", "));
  const one = async <T>(q: ReturnType<typeof sql>): Promise<T> => ((await db.execute(q)).rows[0] ?? {}) as T;

  const feed = await one<{ n: number }>(
    sql`select count(*)::int n from feed_archive where embedding is null and source not in (${structural})`,
  );
  const kept = await one<{ n: number }>(
    sql`select count(*)::int n from classification_archive where embedding is null and kept`,
  );
  const embeddings = await one<{ n: number | null }>(
    sql`select max(count)::int n from ai_usage where kind = 'embedding'
        and date = to_char(now() at time zone 'America/Los_Angeles', 'YYYY-MM-DD')`,
  );
  const pending = await one<{ h: number | null }>(
    sql`select extract(epoch from now() - min(created_at)) / 3600 h from events where review_status = 'pending'`,
  );
  const gdelt = await one<{ n: number }>(
    sql`select count(*)::int n from pending_gdelt_title where resolved_at is null`,
  );
  const bySource = (
    await db.execute(sql`select split_part(source, ':', 1) family, count(*)::int n from events
                         where created_at > now() - interval '24 hours'
                           and review_status = 'approved' and pre_kill_switch_at is null group by 1`)
  ).rows as { family: string; n: number }[];
  const health = (
    await db.execute(sql`select source, extract(epoch from now() - last_success_at) / 3600 h from source_health`)
  ).rows as { source: string; h: number | null }[];

  const translation = await getUsageBudget();

  return {
    translationMonthUsed: translation.monthUsed,
    feedEmbeddingBacklog: Number(feed.n ?? 0),
    keptArchiveBacklog: Number(kept.n ?? 0),
    embeddingsToday: Number(embeddings.n ?? 0),
    oldestPendingReviewHours: pending.h === null || pending.h === undefined ? null : Number(pending.h),
    gdeltQueueWaiting: Number(gdelt.n ?? 0),
    events24hBySource: Object.fromEntries(bySource.map((r) => [r.family, Number(r.n)])),
    hoursSinceSourceSuccess: Object.fromEntries(
      health.map((r) => [r.source, r.h === null ? Number.POSITIVE_INFINITY : Number(r.h)]),
    ),
  };
}

export async function checkPipelineHealth(): Promise<PipelineMetrics> {
  const metrics = await gatherPipelineMetrics();
  const failures = evaluatePipelineHealth(metrics);
  if (failures.length > 0) {
    throw new Error(`Pipeline health: ${failures.length} check(s) failed\n- ${failures.join("\n- ")}\n${JSON.stringify(metrics)}`);
  }
  return metrics;
}
