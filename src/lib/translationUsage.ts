import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { translationUsage } from "@/db/schema";

// Google Cloud Translation's free tier is 500,000 characters/month before
// billing kicks in. The user asked for a hard ceiling under that, with
// no exceptions: 499,000/month, always. This is enforced here, not left
// to "we probably won't hit it" — translateBatch (src/lib/translate.ts)
// checks this before every API call and skips translation (falling back
// to original-language text, same as no key being set at all) rather
// than risk going over.
export const MONTHLY_CHAR_CAP = 499_000;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function daysInMonthUtc(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

export interface UsageBudget {
  monthUsed: number;
  todayUsed: number;
  dailyBudget: number; // remaining monthly budget spread over remaining days, recalculated daily
  remainingToday: number;
}

// Adaptive, not a flat 1/30th split: dailyBudget = whatever's left in the
// monthly cap, divided by however many days (including today) remain in
// the month. A light day doesn't waste quota — it just raises tomorrow's
// share — while the 499,000 hard ceiling below is checked independently
// regardless of how the daily math comes out, so rounding can't cause an
// overage.
export async function getUsageBudget(): Promise<UsageBudget> {
  const db = getDb();
  const now = new Date();
  const today = todayUtc();
  const monthPrefix = today.slice(0, 7); // "YYYY-MM"

  const rows = await db
    .select({ date: translationUsage.date, characters: translationUsage.characters })
    .from(translationUsage)
    .where(sql`${translationUsage.date} LIKE ${monthPrefix + "%"}`);

  const monthUsed = rows.reduce((sum, r) => sum + r.characters, 0);
  const todayUsed = rows.find((r) => r.date === today)?.characters ?? 0;

  const dayOfMonth = now.getUTCDate();
  const daysRemaining = daysInMonthUtc(now) - dayOfMonth + 1; // today counts
  const monthlyRemaining = Math.max(0, MONTHLY_CHAR_CAP - monthUsed);

  // dailyBudget is today's fair share of what's left, computed from the
  // pool *before* today's own usage — not monthlyRemaining, which is
  // already net of todayUsed. Using monthlyRemaining here would subtract
  // today's usage twice: once implicitly (it's already out of the pool)
  // and again explicitly below (dailyBudget - todayUsed).
  const monthUsedBeforeToday = monthUsed - todayUsed;
  const poolForRemainingDays = Math.max(0, MONTHLY_CHAR_CAP - monthUsedBeforeToday);
  const dailyBudget = Math.floor(poolForRemainingDays / Math.max(1, daysRemaining));

  return {
    monthUsed,
    todayUsed,
    dailyBudget,
    remainingToday: Math.max(0, Math.min(dailyBudget - todayUsed, monthlyRemaining)),
  };
}

export async function canAfford(estimatedChars: number): Promise<boolean> {
  const budget = await getUsageBudget();
  return (
    estimatedChars <= budget.remainingToday &&
    budget.monthUsed + estimatedChars <= MONTHLY_CHAR_CAP
  );
}

export async function recordUsage(chars: number): Promise<void> {
  if (chars <= 0) return;
  const db = getDb();
  const today = todayUtc();
  await db
    .insert(translationUsage)
    .values({ date: today, characters: chars })
    .onConflictDoUpdate({
      target: translationUsage.date,
      set: { characters: sql`${translationUsage.characters} + ${chars}` },
    });
}
