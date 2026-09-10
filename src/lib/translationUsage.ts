import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { translationUsage } from "@/db/schema";

// Google Cloud Translation's free tier is 500,000 characters/month before
// billing kicks in (applied as an automatic $10/month credit against the
// standard $20/million rate, not a separate free bucket — see translate.ts's
// byteLength comment for why this app tracks BYTES against that same
// 500,000 figure, not JS string length). The user asked for a hard ceiling
// under that, with no exceptions: 499,000/month, always. This is enforced
// here, not left to "we probably won't hit it" — translateBatch
// (src/lib/translate.ts) checks this before every API call and skips
// translation (falling back to original-language text, same as no key
// being set at all) rather than risk going over.
export const MONTHLY_BYTE_CAP = 499_000;

// One-time reconciliation (2026-09-10): this app's own tracking (character-
// based until today) showed 128,816 used for the month so far, but Google's
// own billing dashboard showed $3.37 gross cost against the $20/million
// rate — 168,500 units, checked live same day. Rather than guess which of
// the two is right, or try to retroactively re-count exact historical text
// in bytes (not stored verbatim per-row), this assumes Google's own meter
// is the ground truth and closes the gap as a dated correction so the
// monthly/daily pacing math below starts from a number that actually
// matches what Google thinks it's billed, not what this app's own
// (possibly undercounting) prior logic believed. See recordUsage's own
// call site in the migrate route or a one-off script — this constant is
// read once by that reconciliation, not by any ongoing code path.
export const RECONCILIATION_2026_09_10 = { priorMonthTotal: 128_816, googleReportedTotal: 168_500 };

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
  // Paced across the day itself, not just across the month (2026-09-10,
  // explicit user request: "figure out a more optimized way so that the
  // telegram stays active 24/7 instead of shutting down"). Previously
  // remainingToday alone let the FULL day's budget be spent the moment it
  // rolled over at UTC midnight — with 19 Telegram channels rotating
  // through every ~15min ingest cycle plus a pending-translation drain
  // each cycle, real demand was consistently burning a whole day's budget
  // within the first few hours, then going dark (no non-English Telegram
  // coverage) for the other ~20 hours until the next UTC day. See
  // getUsageBudget's own comment for the math.
  remainingRightNow: number;
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
  const monthlyRemaining = Math.max(0, MONTHLY_BYTE_CAP - monthUsed);

  // dailyBudget is today's fair share of what's left, computed from the
  // pool *before* today's own usage — not monthlyRemaining, which is
  // already net of todayUsed. Using monthlyRemaining here would subtract
  // today's usage twice: once implicitly (it's already out of the pool)
  // and again explicitly below (dailyBudget - todayUsed).
  const monthUsedBeforeToday = monthUsed - todayUsed;
  const poolForRemainingDays = Math.max(0, MONTHLY_BYTE_CAP - monthUsedBeforeToday);
  const dailyBudget = Math.floor(poolForRemainingDays / Math.max(1, daysRemaining));

  const remainingToday = Math.max(0, Math.min(dailyBudget - todayUsed, monthlyRemaining));

  // Fair share "as of right now" — elapsed UTC hours today / 24, applied to
  // dailyBudget. A floor of 1 hour's worth keeps translation available
  // immediately after UTC midnight rather than blocking everything until
  // real elapsed time accrues from zero; a ceiling of remainingToday keeps
  // this from ever exceeding what the day-level check already allows (this
  // narrows that check, never widens it). This is the same "remaining
  // pool / remaining time" adaptive idea as dailyBudget above, one level
  // finer — month->day becomes day->hour.
  const hoursElapsedToday = now.getUTCHours() + now.getUTCMinutes() / 60;
  const hourlyFloor = dailyBudget / 24;
  const fairShareByNow = Math.max(hourlyFloor, dailyBudget * (hoursElapsedToday / 24));
  const remainingRightNow = Math.max(0, Math.min(remainingToday, Math.floor(fairShareByNow) - todayUsed));

  return {
    monthUsed,
    todayUsed,
    dailyBudget,
    remainingToday,
    remainingRightNow,
  };
}

// A single translateBatch call is one Telegram channel's entire backlog
// of new posts since its last check — nothing previously bounded how
// much of a single day's budget one such call could claim, only whether
// the total fit under what's left today. User report (2026-09-08): the
// budget was capping out early in the day — consistent with exactly
// this, a burst of non-English posts (several channels, each posting a
// lot since the last check) legally spending most or all of
// remainingToday in the first few ingest cycles, leaving nothing for the
// other ~90 cycles still to come that day.
//
// Bounding any single call to a fraction of dailyBudget — not
// remainingToday, which shrinks as the day goes on — keeps the cap
// stable across the whole day rather than getting tighter for later
// calls just because earlier ones already spent some of today's pool.
// A call that exceeds it fails canAfford the same way running out of
// budget entirely does, and telegram.ts's existing fallback already
// queues the excerpts in pending_translation rather than dropping them
// — this doesn't lose content, it just forces a large batch to drain
// gradually across later cycles instead of consuming the whole day's
// allowance in one shot. 1/12th means even the very first call of the
// day leaves at least 11 more "shares" of today's budget for everything
// else still to come.
const MAX_CHARS_PER_CALL_FRACTION = 12;

export async function canAfford(estimatedBytes: number): Promise<boolean> {
  const budget = await getUsageBudget();
  const maxPerCall = Math.floor(budget.dailyBudget / MAX_CHARS_PER_CALL_FRACTION);
  return (
    estimatedBytes <= budget.remainingRightNow &&
    estimatedBytes <= budget.remainingToday &&
    estimatedBytes <= maxPerCall &&
    budget.monthUsed + estimatedBytes <= MONTHLY_BYTE_CAP
  );
}

export async function recordUsage(bytes: number): Promise<void> {
  if (bytes <= 0) return;
  const db = getDb();
  const today = todayUtc();
  await db
    .insert(translationUsage)
    .values({ date: today, characters: bytes })
    .onConflictDoUpdate({
      target: translationUsage.date,
      set: { characters: sql`${translationUsage.characters} + ${bytes}` },
    });
}
