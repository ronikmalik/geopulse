import { sql, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { events, feedArchive } from "@/db/schema";

// Backs GET /api/events/[id]/similar — semantic "similar events" via
// pgvector cosine distance, reading from feed_archive rather than events
// (see the doc comment on feed_archive.embedding in src/db/schema.ts for
// why: it's the durable full corpus, so a story that's aged out of
// events' 30-day window can still be found as a similar past occurrence).
// Looked up by url, the one column both tables share as a stable join
// key, rather than assuming any id correspondence between them.
const SIMILAR_LIMIT = 5;

export interface SimilarEvent {
  id: number;
  source: string;
  url: string;
  title: string;
  country: string | null;
  severity: number;
  publishedAt: string;
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
    .select({ url: events.url })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (eventRow.length === 0) return [];

  const archiveRow = await db
    .select({ embedding: feedArchive.embedding })
    .from(feedArchive)
    .where(eq(feedArchive.url, eventRow[0].url))
    .limit(1);
  const embedding = archiveRow[0]?.embedding;
  if (!embedding) return [];

  const vectorLiteral = JSON.stringify(embedding);
  const rows = await db
    .select({
      id: feedArchive.id,
      source: feedArchive.source,
      url: feedArchive.url,
      title: feedArchive.title,
      country: feedArchive.country,
      severity: feedArchive.severity,
      publishedAt: feedArchive.publishedAt,
      distance: sql<number>`${feedArchive.embedding} <=> ${vectorLiteral}::vector`,
    })
    .from(feedArchive)
    .where(
      sql`${feedArchive.embedding} is not null and ${feedArchive.url} != ${eventRow[0].url}`,
    )
    .orderBy(sql`${feedArchive.embedding} <=> ${vectorLiteral}::vector`)
    .limit(SIMILAR_LIMIT);

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
