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
import { trackFetch, recordSourceHealth } from "./sourceHealth";

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
  // All sources are independent of each other, so they all run
  // concurrently rather than in sequential stages — a slow or unreachable
  // source (each still retries once internally) can't stall the ones that
  // are working. This is what keeps the feed "live": a full ingest cycle
  // takes roughly as long as its single slowest source, not the sum of
  // all of them. Each fetch is wrapped in trackFetch so a per-source
  // success/failure/latency/count gets recorded to source_health
  // regardless of how this particular run turns out overall — see
  // GET /api/admin/health.
  // GDELT fans out into one query per news category; a single failing
  // query must not abort the other six via Promise.all's fail-fast
  // behavior, so each is caught individually and its error collected here
  // — trackFetch's own catch only fires if every single query failed
  // (nothing at all came back), which is the meaningful "is GDELT down"
  // signal for source_health, while the per-query detail still surfaces
  // in this run's error list either way.
  const gdeltQueryErrors: string[] = [];

  const [gdelt, rss, usgs, eonet, gdacs, ioda] = await Promise.all([
    trackFetch("gdelt", async () => {
      const perQuery = await Promise.all(
        Object.values(CATEGORY_QUERIES).map((q) =>
          fetchGdelt(q, 15).catch((err) => {
            gdeltQueryErrors.push(`gdelt(${q}): ${err}`);
            return [] as RawItem[];
          }),
        ),
      );
      const flat = perQuery.flat();
      if (flat.length === 0 && gdeltQueryErrors.length > 0) {
        throw new Error(gdeltQueryErrors.join("; "));
      }
      return flat;
    }),
    trackFetch("rss", fetchAllRssFeeds),
    trackFetch("usgs", fetchUsgsEarthquakes),
    trackFetch("eonet", fetchNasaEonet),
    trackFetch("gdacs", fetchGdacsAlerts),
    trackFetch("ioda", fetchIodaOutages),
  ]);

  const errors = [rss, usgs, eonet, gdacs, ioda]
    .filter((r) => r.error)
    .map((r) => `${r.source}: ${r.error}`);
  // gdelt.error is only set when every query failed (see above) — in that
  // case gdeltQueryErrors already has the same detail, so use it instead
  // of the single collapsed trackFetch error to keep per-query visibility
  // either way.
  errors.push(...gdeltQueryErrors);

  await recordSourceHealth([gdelt, rss, usgs, eonet, gdacs, ioda]);

  // RSS "world news" feeds carry a rolling window that isn't necessarily
  // all breaking — a general feed can still list something from a couple
  // days ago. GDELT's own timespan filter already keeps its results within
  // the last 3h, so this mainly bounds RSS to genuinely recent items,
  // matching the "live/breaking, not background" framing this feed is for.
  const RECENT_WINDOW_MS = 24 * 60 * 60_000;
  const isRecent = (item: RawItem) =>
    Date.now() - item.publishedAt.getTime() < RECENT_WINDOW_MS;

  const all = dedupeByUrl([...gdelt.items, ...rss.items]);
  const candidates = all.filter(
    (item) =>
      isRecent(item) && (item.source === "gdelt" || isLikelyGeopolitical(item)),
  );
  const direct = dedupeDirectByUrl([
    ...usgs.items,
    ...eonet.items,
    ...gdacs.items,
    ...ioda.items,
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
