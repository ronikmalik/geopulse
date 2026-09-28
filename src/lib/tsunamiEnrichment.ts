import { and, eq, gte, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { events, feedArchive } from "@/db/schema";
import {
  fetchTsunamiBulletins,
  matchBulletinToQuake,
  withTsunamiStatus,
  MATCH_WINDOW_AFTER_MS,
  MATCH_WINDOW_BEFORE_MS,
  type TsunamiBulletin,
} from "./sources/tsunami";

// Runs inside every ingest cycle (ingest.ts), after the new USGS rows are
// in. Two small feed requests; a database read only when a bulletin was
// issued in the last BULLETIN_MAX_AGE_MS, which is rare. Writes only when
// the quake's summary would actually change, so repeated cycles over the
// same bulletin are no-ops. feed_archive keeps the same text as events.
const BULLETIN_MAX_AGE_MS = 48 * 60 * 60_000;

export interface TsunamiEnrichmentResult {
  bulletins: number;
  matched: number;
  updated: number;
}

export async function applyTsunamiBulletins(
  fetchBulletins: () => Promise<TsunamiBulletin[]> = fetchTsunamiBulletins,
): Promise<TsunamiEnrichmentResult> {
  const now = Date.now();
  const bulletins = (await fetchBulletins()).filter((b) => now - b.issuedAt.getTime() <= BULLETIN_MAX_AGE_MS);
  if (bulletins.length === 0) return { bulletins: 0, matched: 0, updated: 0 };

  const db = getDb();
  let matched = 0;
  let updated = 0;
  for (const b of bulletins) {
    const quakes = await db
      .select({ id: events.id, url: events.url, summary: events.summary, lat: events.lat, lon: events.lon, publishedAt: events.publishedAt })
      .from(events)
      .where(
        and(
          eq(events.source, "usgs"),
          gte(events.publishedAt, new Date(b.issuedAt.getTime() - MATCH_WINDOW_BEFORE_MS)),
          lte(events.publishedAt, new Date(b.issuedAt.getTime() + MATCH_WINDOW_AFTER_MS)),
        ),
      );
    const id = matchBulletinToQuake(b, quakes);
    if (id === null) continue;
    matched++;
    const quake = quakes.find((q) => q.id === id)!;
    const summary = withTsunamiStatus(quake.summary, b);
    if (summary === quake.summary) continue;
    await db.update(events).set({ summary }).where(eq(events.id, id));
    await db.update(feedArchive).set({ summary }).where(eq(feedArchive.url, quake.url));
    updated++;
  }
  return { bulletins: bulletins.length, matched, updated };
}
