import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { aiUsage } from "@/db/schema";

// See the doc comment on the ai_usage table in src/db/schema.ts. "embedding"
// is a different model (gemini-embedding-001, its own separate 1,000 RPD
// quota — see embeddings.ts) and isn't part of the cap math below. "audit",
// "brief", and "geocode" all share the EXACT SAME model (gemini-3.5-flash-
// lite) and the EXACT SAME 500 RPD / 15 RPM free-tier quota (confirmed live
// via the AI Studio dashboard, 2026-09-10) — three independent callers with
// no shared awareness of each other's consumption, which is exactly how
// that model ended up peaking at 490/500 RPD before this existed.
export type AiUsageKind = "embedding" | "brief" | "audit" | "geocode";

// Explicit daily budget split for the three gemini-3.5-flash-lite callers
// (user request, 2026-09-10: "add the number of max number of calls the
// audit, brief, and geocodes can add up to a day"). Sums to 465, leaving
// real margin under the confirmed 500 RPD ceiling rather than running
// right up against it.
//
// AUDIT gets the large majority share, not an equal split — it's the one
// that actually gates what's credible (reviewPendingEvents) and has to
// stay usable all day; the explicit ceiling is a safety backstop against
// audit itself ever blowing past a safe total, not a tight constraint it's
// expected to bump into under normal operation.
//
// 400 -> 350 -> 285 (2026-09-11, user requests, each paired with an equal
// bump to GEOCODE below — straight reallocations, the sum stays 465 each
// time so the real-quota margin is unchanged). Real daily audit usage has
// been 118-367 on ordinary days; the one outlier (470 on 2026-09-10)
// predates a same-day concurrency fix (recordAiUsage moved to per-round
// instead of end-of-call, since multiple simultaneous invocations were
// overshooting the check before that), so it's not a clean baseline for
// what 285 needs to cover going forward. If audit ever does exhaust 285
// on a genuinely busy day, that's the existing accepted degrade path, not
// a new failure mode: non-gdelt pending items still auto-promote
// unreviewed after PENDING_REVIEW_MAX_AGE_MINUTES regardless, gdelt items
// wait for the next day's backlog sweep — this caller is already
// documented as the lowest-priority consumer of the three.
//
// BRIEF's cap (15) just formalizes the existing natural ceiling
// (MAX_COUNTRIES_PER_RUN in countryBriefs.ts, one run/day) as an enforced
// safety net rather than an incidental one.
//
// GEOCODE's cap: 50 -> 100 -> 165 (2026-09-11, user requests) — real
// production showed the original flat 50/day cap exhausted by ~9.5 hours
// into the Pacific day (last successful geocode 16:39 UTC, then nothing
// for the rest of the day), because backfillEventGeocodes runs once per
// ~15min ingest cycle (~96-110 cycles/day) and real RSS/Telegram intake
// keeps a backlog most cycles, so it was spending its unit almost every
// single cycle. 165 now exceeds that natural ~96-110/day per-cycle
// ceiling — meaning at real steady-state demand, this caller should
// never actually hit this cap at all, the same way BRIEF's cap formalizes
// a ceiling the caller's own natural behavior already respects. Revisit
// if real usage ever suggests otherwise.
export const GEMINI_LITE_DAILY_CAPS: Record<"audit" | "brief" | "geocode", number> = {
  audit: 285,
  brief: 15,
  geocode: 165,
};

// Embedding's own daily pacing (2026-09-11, live-caught): unlike the three
// callers above, "embedding" had no cap at all — embeddingBackfill.ts/
// classificationArchiveEmbeddingBackfill.ts's own 4+4/cycle sizing assumed
// spreading ~768/day evenly was enough margin under the confirmed ~1,000
// RPD ceiling, but real production hit a hard wall less than 11 hours into
// the Pacific day (1,005 successful calls by ~10:48am Pacific, then 429 on
// every attempt for the rest of the day) — the two backfills apparently draw more real-world
// volume per day than that ceiling estimate assumed (a large one-time
// GDELT/telegram backlog inflates a single day's count well past a steady-
// state average), so nothing was pacing consumption ACROSS the day the way
// translationUsage.ts already does for Google Translate. Same fix, same
// shape: a daily cap (900, a deliberate margin under the confirmed ~1,000
// RPD figure — cheaper to recalibrate this one constant later against real
// AI Studio dashboard data than to guess higher and risk the exact same
// mid-day wall) PLUS an intra-day fair-share so the whole day's budget
// can't be front-loaded into the first few hours the way a flat daily
// counter alone would still allow.
export const EMBEDDING_DAILY_CAP = 900;

// Google's Gemini/AI Studio free-tier RPD quotas reset at midnight
// PACIFIC time, not UTC (standard, documented Google Cloud/AI Studio
// behavior) — using a UTC calendar day here meant this module's own
// "today" rolled over at UTC midnight (8pm Eastern during EDT), up to
// ~7 hours before Google's real quota actually refreshes. In that gap,
// canAffordGeminiLiteCall could report a fresh, empty budget while
// Google's own counter was still the OLD, possibly-exhausted one — not a
// crash risk (every caller already degrades gracefully on a real 429,
// unchanged by this file), just a courtesy cap that wasn't actually
// courteous during that window. Fixed 2026-09-10 (user request) by keying
// on the Pacific calendar date instead. Intl.DateTimeFormat with an
// explicit IANA zone handles the PST/PDT transition automatically via
// Node's built-in ICU data — no new dependency, and no manual UTC-offset
// arithmetic to get wrong across a DST boundary.
function todayPacific(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function recordAiUsage(kind: AiUsageKind, count: number): Promise<void> {
  if (count <= 0) return;
  try {
    const db = getDb();
    const today = todayPacific();
    await db
      .insert(aiUsage)
      .values({ date: today, kind, count })
      .onConflictDoUpdate({
        target: [aiUsage.date, aiUsage.kind],
        set: { count: sql`${aiUsage.count} + ${count}` },
      });
  } catch (err) {
    console.error(`recordAiUsage failed: ${err}`);
  }
}

// Read today's count for one kind. Fails OPEN (0, i.e. "assume nothing
// spent yet") on a DB error — the real Google-side 429 is still the
// backstop if this read fails and a caller goes over; this is a courtesy
// cap to stay well clear of that, not the only thing standing between the
// app and an overage. Shared by both the flat gemini-lite caps below and
// embedding's own adaptive pacing (widened from the narrower "audit" |
// "brief" | "geocode" union, 2026-09-11 — the underlying query is already
// generic over AiUsageKind, this was only ever narrowed to match its two
// original callers).
async function todayCountFor(kind: AiUsageKind): Promise<number> {
  try {
    const db = getDb();
    const today = todayPacific();
    const rows = await db
      .select({ count: aiUsage.count })
      .from(aiUsage)
      .where(sql`${aiUsage.date} = ${today} AND ${aiUsage.kind} = ${kind}`)
      .limit(1);
    return rows[0]?.count ?? 0;
  } catch (err) {
    console.error(`todayCountFor(${kind}) failed: ${err}`);
    return 0;
  }
}

// Checked BEFORE spending a call, same "ask first" posture as
// translationUsage.ts's canAfford — a caller at or over its own daily cap
// skips the call entirely (soft-degrades, same as every other Gemini
// caller already does on a real 429) rather than finding out the hard way.
export async function canAffordGeminiLiteCall(
  kind: "audit" | "brief" | "geocode",
  estimatedCalls = 1,
): Promise<boolean> {
  const used = await todayCountFor(kind);
  return used + estimatedCalls <= GEMINI_LITE_DAILY_CAPS[kind];
}

// Same "remaining pool / remaining time" adaptive idea as
// translationUsage.ts's getUsageBudget (see that file's own comment for the
// full reasoning) — one level simpler since embedding's quota is a flat
// daily RPD count, not a monthly byte pool needing a day-level layer first.
// A floor of 1 hour's worth keeps embedding available immediately after
// Pacific midnight rather than blocking until real elapsed time accrues
// from zero.
const EMBEDDING_HOURLY_FLOOR_FRACTION = 1 / 24;

export interface EmbeddingBudget {
  todayUsed: number;
  remainingToday: number;
  remainingRightNow: number;
}

export async function getEmbeddingBudget(): Promise<EmbeddingBudget> {
  const todayUsed = await todayCountFor("embedding");
  const remainingToday = Math.max(0, EMBEDDING_DAILY_CAP - todayUsed);

  // Pacific hour:minute, not UTC (this budget's "today" is the Pacific
  // calendar day — see todayPacific() — so elapsed-time-today has to be
  // measured against that same clock, not UTC's).
  const [pacificHour, pacificMinute] = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  })
    .format(new Date())
    .split(":")
    .map(Number);
  const hoursElapsedToday = pacificHour + pacificMinute / 60;
  const hourlyFloor = EMBEDDING_DAILY_CAP * EMBEDDING_HOURLY_FLOOR_FRACTION;
  const fairShareByNow = Math.max(hourlyFloor, EMBEDDING_DAILY_CAP * (hoursElapsedToday / 24));
  const remainingRightNow = Math.max(0, Math.min(remainingToday, Math.floor(fairShareByNow) - todayUsed));

  return { todayUsed, remainingToday, remainingRightNow };
}

// Checked BEFORE spending a chunk of embedding calls, same "ask first"
// posture as canAffordGeminiLiteCall/translationUsage.ts's canAfford — a
// caller past its pace for right now skips the call entirely (soft-
// degrades to leaving those rows unembedded for a later cycle, same as a
// real 429 already does) rather than spending the day's whole budget in
// the first few hours and going dark for the rest of it.
export async function canAffordEmbeddingCalls(estimatedCalls: number): Promise<boolean> {
  const budget = await getEmbeddingBudget();
  return estimatedCalls <= budget.remainingRightNow && estimatedCalls <= budget.remainingToday;
}

export interface AiUsageSummary {
  date: string;
  kind: string;
  count: number;
}

export async function getRecentAiUsage(days = 14): Promise<AiUsageSummary[]> {
  const db = getDb();
  const rows = await db
    .select({ date: aiUsage.date, kind: aiUsage.kind, count: aiUsage.count })
    .from(aiUsage)
    .orderBy(sql`${aiUsage.date} desc`)
    .limit(days * 4); // up to 4 kinds/day now (embedding, brief, audit, geocode)
  return rows;
}
