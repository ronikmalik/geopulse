import { getDb } from "@/db";
import { events } from "@/db/schema";
import { inArray } from "drizzle-orm";
import type { RawItem } from "./sources/gdelt";
import { discoverGdeltCandidates, drainPendingGdeltTitles } from "./sources/gdeltBulk";
import { fetchAllRssFeeds } from "./sources/rss";
import { fetchUsgsEarthquakes } from "./sources/usgs";
import { fetchNasaEonet } from "./sources/eonet";
import { fetchGdacsAlerts } from "./sources/gdacs";
import { fetchIodaOutages } from "./sources/ioda";
import { fetchFirmsThermalAnomalies } from "./sources/firms";
import { fetchTelegramChannel, TELEGRAM_CHANNELS } from "./sources/telegram";
import { removeAlreadyResolvedPending } from "./pendingTranslation";
import type { DirectItem } from "./sources/direct";
import {
  classifyByKeywords,
  isLikelyGeopolitical,
  assessIncidentSeverity,
  type ClassifiedItem,
} from "./classify";
import { retryFailedClassificationsViaTranslation } from "./classifyTranslated";
import { trackFetch, recordSourceHealth, type TrackedFetch } from "./sourceHealth";
import { correlationGroupId } from "./correlation";
import { archiveClassifications } from "./classificationArchive";
import { archiveFeedItems } from "./feedArchive";
import { fetchRecentPrimaries, findDuplicateOf, type PrimaryCandidate } from "./eventDedup";
import { backfillFeedArchiveEmbeddings } from "./embeddingBackfill";
import { backfillClassificationArchiveEmbeddings } from "./classificationArchiveEmbeddingBackfill";
import { scoreNewNarrativeItems } from "./narrativeNoveltyScoring";
import { backfillEventGeocodes } from "./geocodeBackfill";

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

// Stand-in for trackFetch when a source is deliberately not attempted this
// run (see runIngest's priorityGdelt option) — keeps the Promise.all
// destructure ([gdelt, rss, usgs, ...]) and every downstream read of
// .items/.error unchanged. The result is never actually passed to
// recordSourceHealth (runIngest filters skipped sources out of that call
// separately) specifically so a source that wasn't attempted this run
// doesn't get its lastAttemptAt/lastSuccessAt overwritten as if it had been.
function skippedFetch<T>(source: string): Promise<TrackedFetch<T>> {
  return Promise.resolve({ source, items: [] as T[], latencyMs: 0, error: null });
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
        // No pre-publish review gate for this insert path — used by
        // backfill.ts for structural sources (USGS/EONET), same "no
        // real editorial judgment call" reasoning as the direct-source
        // block in runIngest below.
        reviewStatus: "approved" as const,
      };
    });
    const result = await db
      .insert(events)
      .values(rows)
      .onConflictDoNothing({ target: events.url })
      .returning({ id: events.id });

    // Durable ML-archive copy, independent of `events`' own future
    // retention — see src/lib/feedArchive.ts. Archiving all of `fresh`
    // rather than just what `result` confirms is fine: feed_archive
    // dedupes by url too, and anything that lost the events insert race
    // to a concurrent run was already archived by that run.
    await archiveFeedItems(rows);

    return { inserted: result.length, error: null };
  } catch (err) {
    return { inserted: 0, error: String(err) };
  }
}

// priorityGdelt: skips every source except GDELT, and runs
// PRIORITY_GDELT_QUERIES (see categories.ts for why) instead of the normal
// rotation — used by the dedicated GitHub Actions trigger in
// .github/workflows/ingest-priority.yml, which isn't bound by cron-job.org's
// 30s hard timeout the way the main /api/ingest schedule is, so it can
// afford to run several GDELT queries sequentially every cycle instead of
// just one. Re-fetching RSS/USGS/etc. here too would double their request
// volume for no benefit (the main rotation already covers them every ~15
// min) — skipped sources are stubbed as an already-successful empty fetch
// (skippedFetch below) rather than omitted, so recordSourceHealth still
// gets a well-typed array and the rest of this function's logic (which
// reads gdelt/rss/usgs/etc. by destructured position) needs no other
// change.
export async function runIngest(
  options?: { priorityGdelt?: boolean },
): Promise<IngestResult> {
  const priorityGdelt = options?.priorityGdelt === true;
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
  const ROTATION_INTERVAL_MS = 15 * 60_000;
  const gdeltQueryErrors: string[] = [];
  const GDELT_BULK_TIMEOUT_MS = 20_000;

  // Same rotation cadence as GDELT (ROTATION_INTERVAL_MS) but its own chunk
  // size — 18 channels (as of the 2026-09-04 v2 pass) at 3 per cycle
  // covers the full list roughly every 90 min, comfortably faster than
  // GDELT's 7-category rotation needs.
  const TELEGRAM_CHUNK_SIZE = 3;
  const TELEGRAM_QUERY_SPACING_MS = 800;
  const TELEGRAM_QUERY_TIMEOUT_MS = 7_000;
  const telegramErrors: string[] = [];

  const [gdelt, rss, usgs, eonet, gdacs, ioda, firms, telegram] = await Promise.all([
    // Replaced 2026-09-10: this used to fan out into several sequential
    // DOC 2.0 search-API queries (one per category, or per-country for
    // priorityGdelt — see git history / categories.ts's PRIORITY_GDELT_*
    // constants, now unused). Live production logs showed that API being
    // 429-rate-limited on Vercel's shared outbound IP the vast majority of
    // the time, both here and in the priority workflow, regardless of how
    // conservatively this app paced its own requests — see gdelt.ts's own
    // header comment for the full investigation. gdeltBulk.ts fetches
    // GDELT's own bulk 15-minute Event Database file instead — a
    // completely different, unthrottled host, one small file covering
    // every country and category GDELT recorded in this window, no
    // per-query search net required.
    //
    // Two-stage, same shape as the Telegram translation drain below (see
    // its own comment): a real headline can't be read out of the bulk
    // file itself (see gdeltBulk.ts's header comment for the user-caught
    // bug this fixes — a synthesized guess is never displayed again), so
    // discoverGdeltCandidates only enqueues candidates that clear GDELT's
    // structural filters, and drainPendingGdeltTitles fetches each one's
    // REAL title from its own page before it can become a real item.
    // Drained first for the same "oldest-waiting gets first claim on this
    // cycle's budget" reason as Telegram's drain.
    trackFetch("gdelt", async () => {
      const drained = await drainPendingGdeltTitles().catch((err) => {
        gdeltQueryErrors.push(`gdelt(title-drain): ${err}`);
        return [];
      });
      // discoverGdeltCandidates never returns display items itself (see its
      // own doc comment) — only awaited for its enqueue side effect and to
      // catch its own errors, same "empty result is normal, an error isn't"
      // distinction the throw below relies on.
      try {
        await withDeadline(discoverGdeltCandidates(), GDELT_BULK_TIMEOUT_MS, "gdelt-bulk-discover");
      } catch (err) {
        gdeltQueryErrors.push(`gdelt(discover): ${err}`);
      }
      if (drained.length === 0 && gdeltQueryErrors.length > 0) {
        throw new Error(gdeltQueryErrors.join("; "));
      }
      return drained;
    }),
    priorityGdelt ? skippedFetch<RawItem>("rss") : trackFetch("rss", fetchAllRssFeeds),
    priorityGdelt ? skippedFetch<DirectItem>("usgs") : trackFetch("usgs", fetchUsgsEarthquakes),
    priorityGdelt ? skippedFetch<DirectItem>("eonet") : trackFetch("eonet", fetchNasaEonet),
    priorityGdelt ? skippedFetch<DirectItem>("gdacs") : trackFetch("gdacs", fetchGdacsAlerts),
    priorityGdelt ? skippedFetch<DirectItem>("ioda") : trackFetch("ioda", fetchIodaOutages),
    // No-key-configured is a soft no-op (empty array, no throw) inside
    // fetchFirmsThermalAnomalies itself, so this doesn't show up as a
    // "failing" source in source_health until FIRMS_MAP_KEY is actually set.
    priorityGdelt ? skippedFetch<DirectItem>("firms") : trackFetch("firms", fetchFirmsThermalAnomalies),
    // Same rotation-instead-of-all-at-once reasoning as GDELT above, and
    // for an additional reason here: see docs/TELEGRAM_SOURCES.md — this
    // reads public Telegram channels in a way their own terms don't
    // clearly sanction, a deliberate risk the user accepted, so keeping
    // request volume light matters more than usual, not just for timing.
    priorityGdelt ? skippedFetch<DirectItem>("telegram") : trackFetch("telegram", async () => {
      // No more draining pending_translation for a translation attempt
      // (2026-09-10, user request — see enqueuePendingTranslations's own
      // doc comment) — today's budget goes only to this cycle's live
      // fetch below. removeAlreadyResolvedPending is a pure cleanup (no
      // translation spend): it clears out queued rows that ended up
      // translated some other way, without ever retrying the rest.
      await removeAlreadyResolvedPending().catch((err) => {
        telegramErrors.push(`telegram(pending-cleanup): ${err}`);
      });

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
      const combined = results.flat();
      // Only treated as a failed cycle if truly nothing came out of it —
      // the per-channel errors themselves remain visible via
      // telegramErrors regardless (folded into the top-level errors array
      // below).
      if (combined.length === 0 && telegramErrors.length > 0) {
        throw new Error(telegramErrors.join("; "));
      }
      return combined;
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

  // Skipped sources (priorityGdelt) are deliberately left out here, not
  // just filtered by their null error — see skippedFetch's own comment for
  // why recording them would misrepresent lastAttemptAt for a fetch that
  // never actually ran this cycle.
  await recordSourceHealth(
    priorityGdelt ? [gdelt] : [gdelt, rss, usgs, eonet, gdacs, ioda, firms, telegram],
  );

  // RSS "world news" feeds carry a rolling window that isn't necessarily
  // all breaking — a general feed can still list something from a couple
  // days ago. GDELT's own timespan filter already keeps its results within
  // the last 3h, so this mainly bounds RSS to genuinely recent items,
  // matching the "live/breaking, not background" framing this feed is for.
  const RECENT_WINDOW_MS = 24 * 60 * 60_000;
  const isRecent = (item: RawItem) =>
    Date.now() - item.publishedAt.getTime() < RECENT_WINDOW_MS;

  // GDELT used to be exempted from isLikelyGeopolitical on the assumption
  // that CATEGORY_QUERIES already scopes every result to an on-topic
  // search. Live output (2026-09-04) disproved that: a "North Korea"
  // rotation returned a September 11 retrospective and an unrelated
  // Indonesia-China piece, both tagged north-korea and inserted once the
  // severity floor was loosened for GDELT (see classifyGdeltItem). GDELT's
  // own text search isn't a reliable relevance filter on its own — this
  // topical net still is, so every source (GDELT included) has to clear it
  // before the per-source classifier (lenient or strict) even runs.
  const all = dedupeByUrl([...gdelt.items, ...rss.items]);
  const candidates = all.filter((item) => isRecent(item) && isLikelyGeopolitical(item));
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
    const archiveIndexByUrl = new Map(fresh.map((item, i) => [item.url, i]));

    function buildRow(item: RawItem, c: ClassifiedItem) {
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
        // Gates the live feed pre-publish (2026-09-08 user request) —
        // invisible to every public read path until
        // reviewPendingEvents (classifierAudit.ts) promotes it,
        // usually within this or the next ingest cycle. Applies to
        // every classified source (RSS/GDELT/Telegram) — the direct-
        // source block below skips this entirely.
        reviewStatus: "pending" as const,
      };
    }

    const failedItems: RawItem[] = [];
    const rows = fresh
      .map((item, i) => {
        // classifyGdeltItem's looser bar (2026-09-04) was justified
        // specifically because GDELT items back then came from hand-written
        // CATEGORY_QUERIES already scoped to one named flashpoint topic — a
        // hit was inherently on-topic in a way a general RSS firehose isn't.
        // That justification no longer holds (2026-09-10): GDELT items now
        // come from gdeltBulk.ts's indiscriminate 15-minute Event Database
        // file covering every country and CAMEO event type globally, not a
        // hand-scoped search. Routing them through the SAME strict bar as
        // RSS/Telegram (MIN_SEVERITY_TO_INCLUDE=3, full BENIGN_PATTERNS/
        // ONGOING_COVERAGE_PATTERNS suppression) is what "heavily filtered
        // to only be live breaking news" now actually requires — a mere
        // threat (MILD, severity 2) or a routine "holds talks with"
        // consultation is exactly the noise this bar exists to cut, the
        // same as it already does for every other source. classifyGdeltItem
        // itself is now unused by any live path — left in place, not yet
        // deleted, in case a future narrowly-scoped GDELT path needs it.
        const c = classifyByKeywords(item);
        if (!c) {
          failedItems.push(item);
          return null;
        }
        archiveOutcomes[i].kept = true;
        archiveOutcomes[i].severity = c.severity;
        archiveOutcomes[i].category = c.category;
        return buildRow(item, c);
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    // Translation-fallback retry (2026-09-10) — see classifyTranslated.ts's
    // own doc comment for the full reasoning: a real, severe story
    // reported in a non-English language fails classify.ts's English-only
    // severity regex on the first pass above, purely because of language,
    // not because it isn't real news. Bounded to items that already
    // resolved a country in their original text (see that module), so
    // this doesn't attempt to translate the full RSS/GDELT firehose —
    // only genuinely promising candidates. Own deadline, same pattern as
    // every other enrichment step in this file — a slow/unavailable
    // translation call degrades this one step, not the whole cycle.
    //
    // 4s, not 8s (tightened same day, live-caught): recovered/inserted
    // rows below still need this call's result (a translated item can't
    // join cross-outlet dedup or the insert batch until it's classified),
    // so this genuinely sits on the sequential critical path, unlike the
    // enrichment passes further down that run against ALREADY-inserted
    // events in their own parallel Promise.allSettled block. Landing on
    // top of cycles already running 21-29s pushed several over
    // cron-job.org's hard 30s HTTP timeout the same morning this shipped —
    // confirmed live the ingest itself still completed and wrote real rows
    // every time (Vercel's maxDuration=300 keeps the function running past
    // cron-job.org's client giving up), so this was never data loss, but
    // a slow/unavailable translateBatch call was still eating enough of
    // the shared budget to flip cron-job.org's own health reporting to
    // "failed." withDeadline doesn't cancel the underlying call (see its
    // own comment above) — a translateBatch that's still slow at 4s just
    // gets its result discarded, same graceful degradation as before, not
    // a smaller total timeout budget.
    try {
      const retryResult = await withDeadline(
        retryFailedClassificationsViaTranslation(failedItems, (item) => item.source === "gdelt"),
        4_000,
        "translationRetry",
      );
      for (let j = 0; j < retryResult.recovered.length; j++) {
        const c = retryResult.recovered[j];
        const translatedItem = retryResult.recoveredItems[j];
        const archiveIdx = archiveIndexByUrl.get(translatedItem.url);
        if (archiveIdx !== undefined) {
          archiveOutcomes[archiveIdx].kept = true;
          archiveOutcomes[archiveIdx].severity = c.severity;
          archiveOutcomes[archiveIdx].category = c.category;
          // The archive keeps a readable record of what actually got
          // published, not the untranslated original — same reasoning as
          // storing the translated title/summary on the row itself below.
          archiveOutcomes[archiveIdx].title = translatedItem.title;
          archiveOutcomes[archiveIdx].snippet = translatedItem.snippet;
        }
        rows.push(buildRow(translatedItem, c));
      }
    } catch (err) {
      errors.push(`translationRetry: ${err}`);
    }

    // Cross-outlet duplicate detection (see src/lib/eventDedup.ts) — grouped
    // by (country, category) since that's the dedup scope, one DB query per
    // group rather than per item. Within a group, items are walked oldest
    // to newest so the FIRST report of a story is always the one that ends
    // up as the primary, matching "show it when u click on the first
    // reporting in the feed." Same-ingest-cycle duplicates (two outlets
    // covering the same fresh story in the same 15-minute batch, neither
    // yet in the DB) are tracked in batchPrimaries alongside the real DB
    // pool using negative synthetic ids, resolved to real ids after the
    // primaries' own insert returns them.
    type Row = (typeof rows)[number];
    const resolvedRows: (Row & { primaryEventId: number | null })[] = [];
    const pendingRows: { row: Row; batchPrimaryUrl: string }[] = [];

    const byGroup = new Map<string, Row[]>();
    for (const r of rows) {
      const key = `${r.country}:${r.category}`;
      const group = byGroup.get(key);
      if (group) group.push(r);
      else byGroup.set(key, [r]);
    }

    for (const [key, groupRows] of byGroup) {
      const [country, category] = key.split(":");
      groupRows.sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
      const latest = groupRows[groupRows.length - 1].publishedAt;

      let dbPool: PrimaryCandidate[] = [];
      try {
        dbPool = await fetchRecentPrimaries(country, category, latest);
      } catch (err) {
        errors.push(`dedup fetch (${key}): ${err}`);
      }

      const batchPrimaries: { url: string; title: string; summary: string }[] = [];

      for (const r of groupRows) {
        const pool: PrimaryCandidate[] = [
          ...dbPool,
          ...batchPrimaries.map((b, i) => ({ id: -(i + 1), title: b.title, summary: b.summary })),
        ];
        const matchId = findDuplicateOf(r, pool);

        if (matchId === null) {
          resolvedRows.push({ ...r, primaryEventId: null });
          batchPrimaries.push({ url: r.url, title: r.title, summary: r.summary });
        } else if (matchId > 0) {
          resolvedRows.push({ ...r, primaryEventId: matchId });
        } else {
          pendingRows.push({ row: r, batchPrimaryUrl: batchPrimaries[-matchId - 1].url });
        }
      }
    }

    // Durable ML-archive copy of every RSS/GDELT row that actually
    // reaches `events` — same feed_archive table insertDirectItems writes
    // to, independent of `events`' own future retention (see
    // src/lib/feedArchive.ts). Deliberately includes cross-outlet
    // duplicates (rows with a non-null primaryEventId), not just each
    // story's primary — outlet-count for a story is itself a real signal
    // for future trend/anomaly work, not noise to collapse away.
    const toFeedArchiveRow = (r: Row) => ({
      source: r.source,
      url: r.url,
      title: r.title,
      summary: r.summary,
      category: r.category,
      country: r.country,
      lat: r.lat,
      lon: r.lon,
      severity: r.severity,
      publishedAt: r.publishedAt,
    });

    if (resolvedRows.length > 0) {
      const result = await db
        .insert(events)
        .values(resolvedRows)
        .onConflictDoNothing({ target: events.url })
        .returning({ id: events.id, url: events.url });
      inserted += result.length;
      await archiveFeedItems(resolvedRows.map(toFeedArchiveRow));

      if (pendingRows.length > 0) {
        const urlToId = new Map(result.map((r) => [r.url, r.id]));
        const pendingResolved = pendingRows
          .map(({ row, batchPrimaryUrl }) => {
            const primaryId = urlToId.get(batchPrimaryUrl);
            // The batch-local "primary" this row depends on didn't actually
            // get a fresh id back (e.g. lost an onConflictDoNothing race
            // against a concurrent ingest run) — skip rather than insert an
            // orphaned duplicate with no real primary to attach to.
            if (!primaryId) return null;
            return { ...row, primaryEventId: primaryId };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);

        if (pendingResolved.length > 0) {
          const result2 = await db
            .insert(events)
            .values(pendingResolved)
            .onConflictDoNothing({ target: events.url })
            .returning({ id: events.id });
          inserted += result2.length;
          await archiveFeedItems(pendingResolved.map(toFeedArchiveRow));
        }
      }
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
          // No pre-publish review gate for direct/structural sources
          // (USGS/EONET/GDACS/IODA/FIRMS) — there's no editorial
          // judgment call in "a magnitude-6 earthquake happened here"
          // the way there is for classified RSS/GDELT/Telegram content.
          reviewStatus: "approved" as const,
        };
      });
      const result = await db
        .insert(events)
        .values(rows)
        .onConflictDoNothing({ target: events.url })
        .returning({ id: events.id });
      inserted += result.length;
      // Was missing entirely until 2026-09-08 — feed_archive's own doc
      // comment in src/db/schema.ts always claimed direct sources
      // (USGS/EONET/GDACS/IODA/FIRMS) were included, but this path never
      // actually called archiveFeedItems the way the RSS/GDELT/Telegram
      // classify path and insertDirectItems (used by backfill.ts) both do.
      // Found while wiring up embeddings, which read from feed_archive.
      await archiveFeedItems(
        rows.map((r) => ({
          source: r.source,
          url: r.url,
          title: r.title,
          summary: r.summary,
          category: r.category,
          country: r.country,
          lat: r.lat,
          lon: r.lon,
          severity: r.severity,
          publishedAt: r.publishedAt,
        })),
      );
    } catch (err) {
      errors.push(`direct insert: ${err}`);
    }
  }

  // Best-effort, non-blocking enrichment/review passes — see the doc
  // comment on backfillFeedArchiveEmbeddings for why these run decoupled
  // from the insert paths above rather than inline per-item. Each step
  // is raced against its own short deadline the same way withDeadline
  // already guards the GDELT fetch.
  //
  // reviewPendingEvents and runClassifierAuditSlice used to run here too
  // (both call gemini-3.5-flash-lite, same model as backfillEventGeocodes
  // below) — removed 2026-09-10 on explicit user instruction: real AI
  // Studio dashboard data showed that model peaking at 490/500 RPD and
  // 18/15 RPM, so three independent callers all competing for the same
  // cramped 30s cron-job.org window and the same near-maxed daily budget
  // was making the one that actually gates credibility (reviewPending
  // Events) unreliable. Both now have their own dedicated, decoupled
  // cadence instead — GET /api/admin/review-pending (~every 15min via
  // GitHub Actions, no 30s ceiling to fight) and the once-daily
  // /api/admin/audit-classifier floor (severely deprioritized backlog
  // sweep, see classifierAudit.ts's own comment on runClassifierAudit).
  // backfillEventGeocodes is left running here unchanged — not in scope
  // of this rebalance, still the newest/least-proven of the three and
  // still fine to degrade its own coverage if it eats its own deadline.
  async function runGeminiAuditChain(): Promise<void> {
    try {
      await withDeadline(backfillEventGeocodes(), 5_000, "eventGeocodeBackfill");
    } catch (err) {
      errors.push(`eventGeocodeBackfill: ${err}`);
    }
  }

  // Skipped for priorityGdelt runs — this pass is 429-sensitive (see the
  // comment above) and already runs on its own cadence via the main
  // rotation every ~15 min regardless of caller; doubling its frequency by
  // also running it from the priority path would add real rate-limit risk
  // for zero benefit, since it reviews whatever's pending across ALL
  // sources, not just this call's own inserts.
  // feed_archive's and classification_archive's embedding backfills share
  // the exact same rate-limited Gemini embedding endpoint (see
  // embeddings.ts's 100 RPM ceiling comment) — run sequentially, never
  // concurrently, same "never more than one caller of a rate-limited API
  // in flight at once" discipline already applied to the Gemini text-audit
  // chain after real production 429s. Project 3's classification_archive
  // backfill goes second, not first: feed_archive backs the live "similar
  // events" feature, which is more immediately user-visible than
  // classification_archive's own not-yet-shadow-scored classifier work.
  async function runEmbeddingBackfillChain(): Promise<void> {
    try {
      await withDeadline(backfillFeedArchiveEmbeddings(), 8_000, "embeddingBackfill");
    } catch (err) {
      errors.push(`embeddingBackfill: ${err}`);
    }
    try {
      // 8s, not 5s (an earlier draft's mistake, caught live in production
      // 2026-09-10: the deadline fired every single cycle) — this backfill
      // uses the SAME BACKFILL_BATCH_SIZE=12 as feed_archive's own, which
      // needs ~8s by embeddingBackfill.ts's own documented math (3 chunks
      // of embedBatch's CONCURRENCY=4, 2 gaps of CHUNK_SPACING_MS=3s, plus
      // request time) — there's no reason this backfill would need less
      // time than that identical-shaped one does.
      await withDeadline(backfillClassificationArchiveEmbeddings(), 8_000, "classificationArchiveEmbeddingBackfill");
    } catch (err) {
      errors.push(`classificationArchiveEmbeddingBackfill: ${err}`);
    }
  }

  if (!priorityGdelt) {
    const [, noveltyResult] = await Promise.allSettled([
      runEmbeddingBackfillChain(),
      runGeminiAuditChain(),
      // Project 1 (narrative clustering, 2026-09-09) — pure arithmetic
      // (dot products against a handful of stored centroids), no external
      // API call, so unlike the Gemini-based chains above it has no
      // rate-limit reason to run sequentially after anything else; races
      // alongside them in the same allSettled instead.
      withDeadline(scoreNewNarrativeItems(), 5_000, "narrativeNoveltyScoring"),
    ]);
    if (noveltyResult.status === "rejected") errors.push(`narrativeNoveltyScoring: ${noveltyResult.reason}`);
  }

  return {
    fetched: all.length + direct.length,
    candidates: fresh.length + freshDirect.length,
    inserted,
    errors,
  };
}
