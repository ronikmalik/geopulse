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
import { fetchTelegramChannel, TELEGRAM_CHANNELS } from "./sources/telegram";
import type { DirectItem } from "./sources/direct";
import { classifyByKeywords, isLikelyGeopolitical, assessIncidentSeverity } from "./classify";
import { trackFetch, recordSourceHealth } from "./sourceHealth";
import { correlationGroupId } from "./correlation";
import { archiveClassifications } from "./classificationArchive";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A live run showed a single GDELT query taking ~23s despite being passed
// a 10s timeoutMs — fetchGdelt's internal `AbortSignal.timeout()` did not
// reliably cut the request off within the requested budget against an
// unresponsive-but-not-quite-timed-out-itself endpoint. Racing it against
// our own setTimeout here enforces the deadline from this loop's side
// regardless of what the fetch call is actually doing internally — the
// abandoned fetchGdelt call keeps running in the background (a dangling
// promise, not truly cancelled) but can no longer hold up the ingest run.
function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}: deadline (${ms}ms) exceeded`)), ms),
    ),
  ]);
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
  //
  // But spacing 7 queries out costs wall-clock time this route doesn't
  // actually have: cron-job.org (the external trigger, see
  // docs/ARCHITECTURE.md) enforces a **hard 30s request timeout with no
  // way to raise it** — confirmed directly in its own UI, not assumed.
  // Sequentially attempting all 7 categories, even at a realistic per-
  // query timeout, blows well past that. So instead of every category
  // every cycle, only ROTATION_CHUNK_SIZE categories run per ingest call,
  // chosen deterministically from the current time so consecutive cycles
  // (roughly one every 15 min, however this route gets triggered) advance
  // through the full list, which RSS's continuous coverage of the same
  // topics backstops in the meantime.
  //
  // 2026-09-04: production logs showed GDELT failing with
  // "ConnectTimeoutError... timeout: 10000ms" specifically — a dead
  // giveaway of undici's own internal socket-connect timeout (hardcoded
  // 10s default, and NOT controlled by this file's own timeoutMs/
  // AbortSignal — see src/lib/sources/gdelt.ts's gdeltDispatcher for the
  // undici-issue-tracker-confirmed reasoning). Overriding that to 20s
  // there only helps if this file's own outer timeout budget is raised to
  // actually leave room for a slower-but-real connect to finish — so
  // GDELT_QUERY_TIMEOUT_MS goes up from 10s to 22s. That no longer fits
  // two sequential queries in the 30s budget (2×22s alone blows past it
  // before even counting spacing/response time), so ROTATION_CHUNK_SIZE
  // drops to 1 — slower full-7-category rotation coverage (~1h45m worst
  // case instead of ~1h), traded for each attempted query actually having
  // a real chance to connect instead of being aborted before the TCP
  // handshake can complete. retries: 0 (vs. fetchGdelt's own default of 1)
  // — a same-query retry would double this already-tight budget for no
  // benefit, since a failed query this cycle gets a fresh attempt next
  // rotation regardless.
  const ROTATION_CHUNK_SIZE = 1;
  const ROTATION_INTERVAL_MS = 15 * 60_000;
  const GDELT_QUERY_SPACING_MS = 1500;
  const GDELT_QUERY_TIMEOUT_MS = 22_000;
  const gdeltQueryErrors: string[] = [];

  // Same rotation cadence as GDELT (ROTATION_INTERVAL_MS) but its own chunk
  // size — 9 channels at 3 per cycle covers the full list roughly every
  // 45 min, comfortably faster than GDELT's 7-category rotation needs.
  const TELEGRAM_CHUNK_SIZE = 3;
  const TELEGRAM_QUERY_SPACING_MS = 800;
  const TELEGRAM_QUERY_TIMEOUT_MS = 7_000;
  const telegramErrors: string[] = [];

  const [gdelt, rss, usgs, eonet, gdacs, ioda, firms, telegram] = await Promise.all([
    trackFetch("gdelt", async () => {
      const allQueries = Object.values(CATEGORY_QUERIES);
      const chunkCount = Math.ceil(allQueries.length / ROTATION_CHUNK_SIZE);
      const chunkIndex = Math.floor(Date.now() / ROTATION_INTERVAL_MS) % chunkCount;
      const queries = allQueries.slice(
        chunkIndex * ROTATION_CHUNK_SIZE,
        chunkIndex * ROTATION_CHUNK_SIZE + ROTATION_CHUNK_SIZE,
      );

      const results: RawItem[][] = [];
      for (let i = 0; i < queries.length; i++) {
        if (i > 0) await sleep(GDELT_QUERY_SPACING_MS);
        try {
          results.push(
            await withDeadline(
              fetchGdelt(queries[i], 15, 0, GDELT_QUERY_TIMEOUT_MS),
              GDELT_QUERY_TIMEOUT_MS + 1_000,
              `gdelt(${queries[i]})`,
            ),
          );
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
    // Same rotation-instead-of-all-at-once reasoning as GDELT above, and
    // for an additional reason here: see docs/TELEGRAM_SOURCES.md — this
    // reads public Telegram channels in a way their own terms don't
    // clearly sanction, a deliberate risk the user accepted, so keeping
    // request volume light matters more than usual, not just for timing.
    trackFetch("telegram", async () => {
      const chunkCount = Math.ceil(TELEGRAM_CHANNELS.length / TELEGRAM_CHUNK_SIZE);
      const chunkIndex = Math.floor(Date.now() / ROTATION_INTERVAL_MS) % chunkCount;
      const channels = TELEGRAM_CHANNELS.slice(
        chunkIndex * TELEGRAM_CHUNK_SIZE,
        chunkIndex * TELEGRAM_CHUNK_SIZE + TELEGRAM_CHUNK_SIZE,
      );

      const results: DirectItem[][] = [];
      for (let i = 0; i < channels.length; i++) {
        if (i > 0) await sleep(TELEGRAM_QUERY_SPACING_MS);
        try {
          results.push(
            await withDeadline(
              fetchTelegramChannel(channels[i]),
              TELEGRAM_QUERY_TIMEOUT_MS + 1_000,
              `telegram(${channels[i].handle})`,
            ),
          );
        } catch (err) {
          telegramErrors.push(`telegram(${channels[i].handle}): ${err}`);
          results.push([]);
        }
      }
      const flat = results.flat();
      if (flat.length === 0 && telegramErrors.length > 0) {
        throw new Error(telegramErrors.join("; "));
      }
      return flat;
    }),
  ]);

  const errors = [rss, usgs, eonet, gdacs, ioda, firms, telegram]
    .filter((r) => r.error)
    .map((r) => `${r.source}: ${r.error}`);
  // gdelt.error is only set when every query failed (see above) — in that
  // case gdeltQueryErrors already has the same detail, so use it instead
  // of the single collapsed trackFetch error to keep per-query visibility
  // either way. Same reasoning applies to telegramErrors.
  errors.push(...gdeltQueryErrors, ...telegramErrors);

  await recordSourceHealth([gdelt, rss, usgs, eonet, gdacs, ioda, firms, telegram]);

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
    ...telegram.items,
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
  //
  // Every candidate — kept AND dropped — is archived to
  // classification_archive (see src/lib/classificationArchive.ts) as a
  // side effect of this same pass, not a separate query: the point is
  // building a real, growing dataset of what the severity gate is
  // currently rejecting, so new incident vocabulary can be found with
  // actual evidence instead of guessing. Dropped items don't get a
  // category from classifyByKeywords (it bails before computing one), so
  // severity is independently recomputed via assessIncidentSeverity for
  // archival purposes — cheap, pure, and already exported for exactly
  // this kind of reuse.
  try {
    const archiveOutcomes = fresh.map((item) => {
      const text = `${item.title} ${item.snippet}`;
      return {
        source: item.source,
        url: item.url,
        title: item.title,
        snippet: item.snippet,
        kept: false,
        severity: assessIncidentSeverity(text) ?? 1,
        category: null as string | null,
        publishedAt: item.publishedAt,
      };
    });

    const rows = fresh
      .map((item, i) => {
        const c = classifyByKeywords(item);
        if (!c) return null;
        archiveOutcomes[i].kept = true;
        archiveOutcomes[i].severity = c.severity;
        archiveOutcomes[i].category = c.category;
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

    await archiveClassifications(archiveOutcomes);
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
