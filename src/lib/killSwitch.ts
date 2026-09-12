import { isNull, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { events } from "@/db/schema";

// The front-end kill switch (2026-09-11 user request): "remove all of the
// feed and let it recalibrate... the data should remain in archives on the
// back end after this switch is activated and earmarked as pre-kill
// switched but i want the new feed to only reflect the changes i have
// made." Deliberately a hide, never a delete — see events.preKillSwitchAt's
// own doc comment in schema.ts for the full read-path list this excludes
// from. A row inserted AFTER activation naturally has preKillSwitchAt =
// NULL and appears normally the moment it clears the ordinary review gate
// — no separate "resume" step needed, the switch only ever acts on rows
// that already existed at the moment it's pulled.
export const NOT_KILL_SWITCHED = isNull(events.preKillSwitchAt);

export interface KillSwitchStatus {
  liveCount: number;
  killedCount: number;
  lastActivatedAt: string | null;
}

export async function getKillSwitchStatus(): Promise<KillSwitchStatus> {
  const db = getDb();
  const [row] = await db
    .select({
      liveCount: sql<number>`count(*) filter (where ${events.preKillSwitchAt} is null)`,
      killedCount: sql<number>`count(*) filter (where ${events.preKillSwitchAt} is not null)`,
      lastActivatedAt: sql<string | null>`max(${events.preKillSwitchAt})`,
    })
    .from(events);
  return {
    liveCount: Number(row?.liveCount ?? 0),
    killedCount: Number(row?.killedCount ?? 0),
    lastActivatedAt: row?.lastActivatedAt ?? null,
  };
}

// Earmarks every currently-existing row in one pass — a single UPDATE, not
// a delete-and-reinsert, so every FK pointing at events.id (primaryEventId,
// classifier_audit joins, embeddings keyed by url, etc.) stays intact.
// Idempotent: a row already earmarked (from a prior activation) keeps its
// original timestamp rather than getting bumped to now — re-running this
// only ever affects rows that are genuinely new since the last activation.
export async function activateKillSwitch(): Promise<{ killed: number; activatedAt: string }> {
  const db = getDb();
  const activatedAt = new Date();
  const result = await db
    .update(events)
    .set({ preKillSwitchAt: activatedAt })
    .where(NOT_KILL_SWITCHED)
    .returning({ id: events.id });
  return { killed: result.length, activatedAt: activatedAt.toISOString() };
}

// Full reverse — clears every earmark, restoring the feed to exactly what
// it showed before activation. Nothing was ever deleted, so this is always
// available, not a time-limited undo.
export async function restoreKillSwitch(): Promise<{ restored: number }> {
  const db = getDb();
  const result = await db
    .update(events)
    .set({ preKillSwitchAt: null })
    .where(isNotNull(events.preKillSwitchAt))
    .returning({ id: events.id });
  return { restored: result.length };
}
