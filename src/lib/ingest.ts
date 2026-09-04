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
import { fetchFirmsThermalAnomalies } from "./sources/firms";
import type { DirectItem } from "./sources/direct";
import { classifyByKeywords, isLikelyGeopolitical } from "./classify";
import { trackFetch, recordSourceHealth } from "./sourceHealth";
import { correlationGroupId } from "./correlation";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

// Used by src/lib/backfill.ts — dedupes against already-stored URLs,
// computes each item's correlation group, and inserts. runIngest below
// has its own inline version of this same DirectItem -> row mapping
// (deliberately not refactored to share this helper — that logic is
// already live and verified, and this session's hard-won lesson is not to
// touch working, tested code paths under time pressure for a pure
// refactor with no behavior change).
export async function insertDirectItems(
  itemsIn: DirectItem[],
): Promise<{ inserted: number; error: string | null }> {
  const items = dedupeDirectByUrl(itemsIn);
  if (items.length === 0) return { inserted: 0, error: null };

  const db = getDb();
  try {
    const existing = await db
      .select({ url: events.url })
      .from(events)
      .where(inArray(events.url, items.map((i) => i.url)))
      .catch(() => []);
    const existingUrls = new Set(existing.map((e) => e.url));
    const fresh = items.filter((i) => !existingUrls.has(i.url));
    if (fresh.length === 0) return { inserted: 0, error: null };

    const rows = fresh.map((item) => {
      const country = item.country ? item.country.toUpperCase() : null;
      return {
        source: item.source,
        url: item.url,
        title: item.title,
        summary: item.summary,
        category: item.category,
        location: item.location,
        country,
        lat: item.lat,
        lon: item.lon,
        severity: item.severity,
        publishedAt: item.publishedAt,
        correlationGroupId: country
          ? correlationGroupId(country, item.category, item.publishedAt)
          : null,
      };
    });
    const result = await db
      .insert(events)
      .values(rows)
      .onConflictDoNothing({ target: events.url })
      .returning({ id: events.id });
    return { inserted: result.length, error: null };
  } catch (err) {
    return { inserted: 0, error: String(err) };
  }
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
  //
  // Sequential with spacing, not Promise.all: GDELT's own docs say their
  // APIs are "rate limited to protect the underlying ElasticSearch
  // clusters", and this app was firing all 7 category queries
  // simultaneously every ~15 min — a real burst-of-7-concurrent-requests
  // pattern from the same IP, repeated on a cron. A live curl test against
  // GDELT (independent of this app) also showed ~11-13s just to get a 429
  // back, well past this app's old 7s per-query timeout — so some of what
  // source_health was logging as "GDELT down" was actually this app
  // aborting a slow-but-real response, not GDELT rejecting the request.
  // retries: 0 here (rather than fetchGdelt's own default of 1) because
  // serialization already means one query's failure doesn't cost the
  // others anything — a same-query retry would just double the worst-case
  // wall-clock time for no corresponding benefit.
  //
  // GDELT_MAX_PHASE_MS bounds the *total* time this sequential fan-out can
  // spend, not just each query — cron-job.org's own request timeout and
  // Vercel's practical (not just configured) execution ceiling both cap
  // how long the whole /api/ingest response can take, and 7 queries at a
  // generous 15s timeout each could in the worst case (GDELT fully down)
  // add up to well over either of those. Once the budget is spent, any
  // remaining categories are skipped for this run rather than attempted —
  // they'll just get picked up on the next ingest cycle a few minutes
  // later, same as if this run's ingest simply hadn't happened yet.
  const GDELT_QUERY_SPACING_MS = 1500;
  const GDELT_MAX_PHASE_MS = 40_000;
  const gdeltQueryErrors: string[] = [];

  const [gdelt, rss, usgs, eonet, gdacs, ioda, firms] = await Promise.all([
    trackFetch("gdelt", async () => {
      const results: RawItem[][] = [];
      const queries = Object.values(CATEGORY_QUERIES);
      const phaseStart = Date.now();
      for (let i = 0; i < queries.length; i++) {
        if (Date.now() - phaseStart > GDELT_MAX_PHASE_MS) {
          gdeltQueryErrors.push(
            `gdelt(${queries[i]}): skipped, GDELT phase budget (${GDELT_MAX_PHASE_MS}ms) exhausted`,
          );
          continue;
        }
        if (i > 0) await sleep(GDELT_QUERY_SPACING_MS);
        try {
          results.push(await fetchGdelt(queries[i], 15, 0));
        } catch (err) {
          gdeltQueryErrors.push(`gdelt(${queries[i]}): ${err}`);
          results.push([]);
        }
      }
      const flat = results.flat();
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
    // No-key-configured is a soft no-op (empty array, no throw) inside
    // fetchFirmsThermalAnomalies itself, so this doesn't show up as a
    // "failing" source in source_health until FIRMS_MAP_KEY is actually set.
    trackFetch("firms", fetchFirmsThermalAnomalies),
  ]);

  const errors = [rss, usgs, eonet, gdacs, ioda, firms]
    .filter((r) => r.error)
    .map((r) => `${r.source}: ${r.error}`);
  // gdelt.error is only set when every query failed (see above) — in that
  // case gdeltQueryErrors already has the same detail, so use it instead
  // of the single collapsed trackFetch error to keep per-query visibility
  // either way.
  errors.push(...gdeltQueryErrors);

  await recordSourceHealth([gdelt, rss, usgs, eonet, gdacs, ioda, firms]);

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
    ...firms.items,
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
        const country = c.country.toUpperCase();
        return {
          source: item.source,
          url: item.url,
          title: item.title,
          summary: c.summary,
          category: c.category,
          location: c.location,
          country,
          lat: c.lat,
          lon: c.lon,
          severity: c.severity,
          publishedAt: item.publishedAt,
          correlationGroupId: correlationGroupId(country, c.category, item.publishedAt),
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
      const rows = freshDirect.map((item) => {
        const country = item.country ? item.country.toUpperCase() : null;
        return {
          source: item.source,
          url: item.url,
          title: item.title,
          summary: item.summary,
          category: item.category,
          location: item.location,
          country,
          lat: item.lat,
          lon: item.lon,
          severity: item.severity,
          publishedAt: item.publishedAt,
          correlationGroupId: country
            ? correlationGroupId(country, item.category, item.publishedAt)
            : null,
        };
      });
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
