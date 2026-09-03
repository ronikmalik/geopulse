import { getDb } from "@/db";
import { events } from "@/db/schema";
import { inArray } from "drizzle-orm";
import { CATEGORY_QUERIES } from "./categories";
import { fetchGdelt, type RawItem } from "./sources/gdelt";
import { fetchAllRssFeeds } from "./sources/rss";
import { fetchUsgsEarthquakes } from "./sources/usgs";
import { fetchNasaEonet } from "./sources/eonet";
import { fetchGdacsAlerts } from "./sources/gdacs";
import { fetchIodaOutages } from "./sources/ioda";
import type { DirectItem } from "./sources/direct";
import { classifyByKeywords, isLikelyGeopolitical } from "./classify";

function dedupeByUrl(items: RawItem[]): RawItem[] {
  const seen = new Map<string, RawItem>();
  for (const item of items) seen.set(item.url, item);
  return [...seen.values()];
}

function dedupeDirectByUrl(items: DirectItem[]): DirectItem[] {
  const seen = new Map<string, DirectItem>();
  for (const item of items) seen.set(item.url, item);
  return [...seen.values()];
}

export interface IngestResult {
  fetched: number;
  candidates: number;
  inserted: number;
  errors: string[];
}

export async function runIngest(): Promise<IngestResult> {
  const errors: string[] = [];

  // All sources are independent of each other, so they all run
  // concurrently rather than in sequential stages — a slow or unreachable
  // source (each still retries once internally) can't stall the ones that
  // are working. This is what keeps the feed "live": a full ingest cycle
  // takes roughly as long as its single slowest source, not the sum of
  // all of them.
  const [gdeltResults, rssResults, usgsResults, eonetResults, gdacsResults, iodaResults] =
    await Promise.all([
      Promise.all(
        Object.values(CATEGORY_QUERIES).map((q) =>
          fetchGdelt(q, 15).catch((err) => {
            errors.push(`gdelt(${q}): ${err}`);
            return [] as RawItem[];
          }),
        ),
      ),
      fetchAllRssFeeds().catch((err) => {
        errors.push(`rss: ${err}`);
        return [] as RawItem[];
      }),
      fetchUsgsEarthquakes().catch((err) => {
        errors.push(`usgs: ${err}`);
        return [] as DirectItem[];
      }),
      fetchNasaEonet().catch((err) => {
        errors.push(`eonet: ${err}`);
        return [] as DirectItem[];
      }),
      fetchGdacsAlerts().catch((err) => {
        errors.push(`gdacs: ${err}`);
        return [] as DirectItem[];
      }),
      fetchIodaOutages().catch((err) => {
        errors.push(`ioda: ${err}`);
        return [] as DirectItem[];
      }),
    ]);

  // RSS "world news" feeds carry a rolling window that isn't necessarily
  // all breaking — a general feed can still list something from a couple
  // days ago. GDELT's own timespan filter already keeps its results within
  // the last 3h, so this mainly bounds RSS to genuinely recent items,
  // matching the "live/breaking, not background" framing this feed is for.
  const RECENT_WINDOW_MS = 24 * 60 * 60_000;
  const isRecent = (item: RawItem) =>
    Date.now() - item.publishedAt.getTime() < RECENT_WINDOW_MS;

  const all = dedupeByUrl([...gdeltResults.flat(), ...rssResults]);
  const candidates = all.filter(
    (item) =>
      isRecent(item) && (item.source === "gdelt" || isLikelyGeopolitical(item)),
  );
  const direct = dedupeDirectByUrl([
    ...usgsResults,
    ...eonetResults,
    ...gdacsResults,
    ...iodaResults,
  ]);

  if (candidates.length === 0 && direct.length === 0) {
    return {
      fetched: all.length + direct.length,
      candidates: 0,
      inserted: 0,
      errors,
    };
  }

  const db = getDb();

  // Skip URLs we've already stored.
  const allUrls = [...candidates.map((c) => c.url), ...direct.map((d) => d.url)];
  const existing = await db
    .select({ url: events.url })
    .from(events)
    .where(inArray(events.url, allUrls))
    .catch(() => []);
  const existingUrls = new Set(existing.map((e) => e.url));
  const fresh = candidates.filter((c) => !existingUrls.has(c.url));
  const freshDirect = direct.filter((d) => !existingUrls.has(d.url));

  let inserted = 0;

  // classifyByKeywords is a pure, synchronous, local function (no external
  // API), so unlike the old LLM-based classifyBatch this needs no batching
  // or rate-limit pacing between calls.
  try {
    const rows = fresh
      .map((item) => {
        const c = classifyByKeywords(item);
        if (!c) return null;
        return {
          source: item.source,
          url: item.url,
          title: item.title,
          summary: c.summary,
          category: c.category,
          location: c.location,
          country: c.country.toUpperCase(),
          lat: c.lat,
          lon: c.lon,
          severity: c.severity,
          publishedAt: item.publishedAt,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (rows.length > 0) {
      const result = await db
        .insert(events)
        .values(rows)
        .onConflictDoNothing({ target: events.url })
        .returning({ id: events.id });
      inserted += result.length;
    }
  } catch (err) {
    errors.push(`classify: ${err}`);
  }

  if (freshDirect.length > 0) {
    try {
      const rows = freshDirect.map((item) => ({
        source: item.source,
        url: item.url,
        title: item.title,
        summary: item.summary,
        category: item.category,
        location: item.location,
        country: item.country ? item.country.toUpperCase() : null,
        lat: item.lat,
        lon: item.lon,
        severity: item.severity,
        publishedAt: item.publishedAt,
      }));
      const result = await db
        .insert(events)
        .values(rows)
        .onConflictDoNothing({ target: events.url })
        .returning({ id: events.id });
      inserted += result.length;
    } catch (err) {
      errors.push(`direct insert: ${err}`);
    }
  }

  return {
    fetched: all.length + direct.length,
    candidates: fresh.length + freshDirect.length,
    inserted,
    errors,
  };
}
