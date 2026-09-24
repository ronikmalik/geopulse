import { sql, eq, and, ne, isNull, notInArray, inArray, gte, lte, or } from "drizzle-orm";
import { getDb } from "@/db";
import { events, feedArchive } from "@/db/schema";
import { NOT_KILL_SWITCHED } from "./killSwitch";
import { STRUCTURAL_SOURCES, isStructuralSource } from "./structuralSources";

// Backs GET /api/events/similar?id= — the "Related:" list under an expanded
// feed card. Two strategies, chosen by the event's source:
//
//   news (RSS/GDELT/Telegram): semantic nearest neighbours via pgvector
//   cosine distance over feed_archive (the durable full corpus, so a story
//   that has aged out of events' 30-day window can still surface as a
//   similar past occurrence — see feed_archive.embedding's doc comment in
//   schema.ts). Looked up by url, the one column both tables share.
//
//   structural (usgs/eonet/gdacs/ioda/firms): a structured lookup instead
//   (2026-09-20) — see structuralSources.ts for why these rows are no
//   longer embedded at all. What a reader wants next to a quake, an outage
//   signal or a satellite fire cluster is the NEWS about it, and that is a
//   question of place and time, not of text similarity: approved news
//   events in the same country (or within a ~3° box of the coordinates,
//   for the coordinate-bearing sources) published within ±48h, same
//   category first, then closest in time. Two ways to qualify, either
//   suffices: inside the coordinate box (the event and the story are
//   physically near each other — news rows carry a geocoded point since
//   geocodeBackfill.ts, or the country centroid before that), or same
//   country AND a hazard-family category. Bare "same country" is NOT
//   enough: live test on a Xinjiang quake surfaced a Beijing tariff story
//   at time-proximity 0.09, which is the opposite of related.
const SIMILAR_LIMIT = 5;
const RELATED_WINDOW_HOURS = 48;
const RELATED_DEGREE_BOX = 3; // ~330 km at the equator; coarse on purpose
// News categories that can plausibly be ABOUT a structural event (a quake,
// a fire, an outage, a disaster alert). Deliberately excludes the conflict
// and politics categories — a quake and a coup in the same country in the
// same 48h are not related.
const HAZARD_FAMILY_CATEGORIES = ["earthquake", "natural-disaster", "climate-hazard", "infrastructure-outage", "humanitarian"] as const;

export interface SimilarEvent {
  id: number;
  source: string;
  url: string;
  title: string;
  country: string | null;
  severity: number;
  publishedAt: string;
  // Cosine similarity for the semantic path; for the structural path a
  // time-proximity score in the same 0..1 range (1 = same moment). The
  // UI does not currently render it either way.
  similarity: number;
}

// Returns [] (not an error) whenever the feature simply isn't ready yet
// for this event — no embedding computed for it as of the last ingest
// cycle (a freshly-inserted event, or embeddings not yet backfilled), or
// GEMINI_API_KEY isn't configured at all. Same graceful-degradation
// posture as AdditionalSources in FeedPanel.tsx returning null on an
// empty list — this is enrichment, never something the UI should treat
// as broken when absent.
export async function getSimilarEvents(eventId: number): Promise<SimilarEvent[]> {
  const db = getDb();

  const eventRow = await db
    .select({
      url: events.url,
      source: events.source,
      country: events.country,
      category: events.category,
      lat: events.lat,
      lon: events.lon,
      publishedAt: events.publishedAt,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (eventRow.length === 0) return [];
  const event = eventRow[0];

  if (isStructuralSource(event.source)) return relatedStructuralEvents(eventId, event);

  const archiveRow = await db
    .select({ embedding: feedArchive.embedding })
    .from(feedArchive)
    .where(eq(feedArchive.url, event.url))
    .limit(1);
  const embedding = archiveRow[0]?.embedding;
  if (!embedding) return [];

  const vectorLiteral = JSON.stringify(embedding);
  // Iterative index scan, in the same transaction as the query (2026-09-24).
  // The HNSW index returns its ~40 nearest candidates and only THEN applies
  // the WHERE clause; once same-channel Telegram rows were excluded, a
  // PressTV post's 40 nearest were nearly all PressTV and its related list
  // shrank to 0-1. iterative_scan (pgvector >= 0.8; this database runs
  // 0.8.6) keeps scanning until the LIMIT is met — 5 results in ~74 ms,
  // measured. relaxed_order may return them slightly out of order, so
  // they're re-sorted by distance below.
  const [, rawRows] = await db.batch([
    db.execute(sql`set local hnsw.iterative_scan = relaxed_order`),
    db
    .select({
      id: feedArchive.id,
      source: feedArchive.source,
      url: feedArchive.url,
      title: feedArchive.title,
      country: feedArchive.country,
      severity: feedArchive.severity,
      publishedAt: feedArchive.publishedAt,
      distance: sql<number>`${feedArchive.embedding} <=> ${vectorLiteral}::halfvec`,
    })
    .from(feedArchive)
    .where(
      and(
        sql`${feedArchive.embedding} is not null and ${feedArchive.url} != ${event.url}`,
        // Older structural rows may still carry an embedding from before
        // 2026-09-20; they'd rarely rank anyway, but keep the list to news.
        notInArray(feedArchive.source, [...STRUCTURAL_SOURCES]),
        // A Telegram post's related list excludes its own channel
        // (2026-09-24, measured): 93-100% of related results for PressTV,
        // the Ukrainian Air Force and other channels were more posts from
        // the same channel — "related" had become "more from this feed".
        // Partly because every stored post carried the channel's label
        // (embeddingBackfill.ts no longer embeds it), partly because one
        // channel does post about one theme. GDELT is left alone: it is
        // one source label spanning many different outlets.
        event.source.startsWith("telegram:") ? ne(feedArchive.source, event.source) : undefined,
      ),
    )
    .orderBy(sql`${feedArchive.embedding} <=> ${vectorLiteral}::halfvec`)
    .limit(SIMILAR_LIMIT),
  ]);
  const rows = [...rawRows].sort((a, b) => Number(a.distance) - Number(b.distance));

  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    url: r.url,
    title: r.title,
    country: r.country,
    severity: r.severity,
    publishedAt: r.publishedAt.toISOString(),
    similarity: 1 - Number(r.distance),
  }));
}

async function relatedStructuralEvents(
  eventId: number,
  event: { country: string | null; category: string; lat: number; lon: number; publishedAt: Date },
): Promise<SimilarEvent[]> {
  const db = getDb();
  const windowMs = RELATED_WINDOW_HOURS * 60 * 60_000;
  const from = new Date(event.publishedAt.getTime() - windowMs);
  const to = new Date(event.publishedAt.getTime() + windowMs);

  const insideBox = and(
    gte(events.lat, event.lat - RELATED_DEGREE_BOX),
    lte(events.lat, event.lat + RELATED_DEGREE_BOX),
    gte(events.lon, event.lon - RELATED_DEGREE_BOX),
    lte(events.lon, event.lon + RELATED_DEGREE_BOX),
  );
  const sameCountryHazard = event.country
    ? and(eq(events.country, event.country), inArray(events.category, [...HAZARD_FAMILY_CATEGORIES]))
    : undefined;
  const nearby = sameCountryHazard ? or(insideBox, sameCountryHazard) : insideBox;

  const rows = await db
    .select({
      id: events.id,
      source: events.source,
      url: events.url,
      title: events.title,
      country: events.country,
      severity: events.severity,
      publishedAt: events.publishedAt,
    })
    .from(events)
    .where(
      and(
        ne(events.id, eventId),
        eq(events.reviewStatus, "approved"),
        isNull(events.primaryEventId),
        NOT_KILL_SWITCHED,
        notInArray(events.source, [...STRUCTURAL_SOURCES]),
        gte(events.publishedAt, from),
        lte(events.publishedAt, to),
        nearby,
      ),
    )
    .orderBy(
      sql`(${events.category} = ${event.category}) desc`,
      sql`abs(extract(epoch from (${events.publishedAt} - ${event.publishedAt}::timestamptz)))`,
    )
    .limit(SIMILAR_LIMIT);

  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    url: r.url,
    title: r.title,
    country: r.country,
    severity: r.severity,
    publishedAt: r.publishedAt.toISOString(),
    similarity: Math.max(0, 1 - Math.abs(r.publishedAt.getTime() - event.publishedAt.getTime()) / windowMs),
  }));
}
