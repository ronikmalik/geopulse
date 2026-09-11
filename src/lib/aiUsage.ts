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
// BRIEF's cap (15) just formalizes the existing natural ceiling
// (MAX_COUNTRIES_PER_RUN in countryBriefs.ts, one run/day) as an enforced
// safety net rather than an incidental one.
//
// GEOCODE's cap (50) is the real cut: it previously ran uncapped, once per
// ~15min ingest cycle (up to 96 calls/day) — the one caller nobody had
// touched in the earlier audit-priority rebalance. This directly frees the
// headroom the other two now have.
export const GEMINI_LITE_DAILY_CAPS: Record<"audit" | "brief" | "geocode", number> = {
  audit: 400,
  brief: 15,
  geocode: 50,
};

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function recordAiUsage(kind: AiUsageKind, count: number): Promise<void> {
  if (count <= 0) return;
  try {
    const db = getDb();
    const today = todayUtc();
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

// Read today's count for one gemini-3.5-flash-lite kind. Fails OPEN (0,
// i.e. "assume nothing spent yet") on a DB error — the real Google-side
// 429 is still the backstop if this read fails and a caller goes over;
// this is a courtesy cap to stay well clear of that, not the only thing
// standing between the app and an overage.
async function todayCountFor(kind: "audit" | "brief" | "geocode"): Promise<number> {
  try {
    const db = getDb();
    const today = todayUtc();
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
