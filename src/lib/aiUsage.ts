import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { aiUsage } from "@/db/schema";

// See the doc comment on the ai_usage table in src/db/schema.ts — this is
// visibility, not a billing gate. Gemini's free tier costs nothing as long
// as no billing account is linked to the Google AI Studio project; a 429
// once the free quota's hit is just a soft failure the caller already
// retries next cycle. Kept deliberately parallel in shape to
// translationUsage.ts (todayUtc, onConflictDoUpdate increment) even though
// there's no cap math here, so the two are easy to compare at a glance.
export type AiUsageKind = "embedding" | "brief" | "audit";

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
    .limit(days * 2); // at most 2 kinds/day today (embedding, brief)
  return rows;
}
