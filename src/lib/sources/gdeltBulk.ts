import { unzipSync } from "fflate";
import type { RawItem } from "./gdelt";
import { fipsToIso2 } from "../fipsCountryCodes";
import { isWorthFetchingRealTitle } from "../cameoEventCodes";
import { fetchRealArticleTitle } from "../articleTitleFetch";
import {
  enqueuePendingGdeltTitles,
  getPendingGdeltTitleBatch,
  deletePendingGdeltTitles,
  expireStalePendingGdeltTitles,
} from "../pendingGdeltTitle";

// Replaces this app's original GDELT ingestion path (the DOC 2.0 full-text
// search API, api.gdeltproject.org, still implemented in gdelt.ts) for the
// reason documented at length in that file: GDELT's search API is rate-
// limited (429, with a materially longer "sticky" cooldown after any
// violation) on a shared, dynamic Vercel outbound IP — live production logs
// 2026-09-10 showed this failing the vast majority of requests, both the
// main rotation's single query per cycle and the priority workflow's
// dedicated per-country query burst. GDELT's own project blog is explicit
// that this rate limit exists specifically to protect the search
// ElasticSearch cluster and recommends bulk file access for high-volume use.
//
// GDELT republishes its full structured Event Database as a small
// tab-delimited file every 15 minutes, on a completely different host
// (data.gdeltproject.org — plain static file serving, not the rate-limited
// search cluster) with no documented per-request limit: ~110KB compressed,
// covering EVERY event GDELT recorded globally in that window, already
// carrying a CAMEO action code, a country attribution, and a source URL —
// no search-query keyword net required at all, and no more "add another
// hand-written boolean query per country" scaling problem (see categories.
// ts's PRIORITY_GDELT_ROTATION, now unused — see that file's own note).
//
// REWRITTEN 2026-09-10 (user-caught bug): this used to synthesize a title
// directly from GDELT's structured CAMEO fields (see cameoEventCodes.ts's
// own doc comment) and publish it immediately. That meant every card's
// displayed title was a guessed sentence, never the real headline of the
// article at its own URL — clicking through showed a different, real
// story. Fixed by splitting into two stages, the same "queue now, do the
// real work on a later cycle" shape already used for embeddings/geocoding/
// Telegram translation: discoverGdeltCandidates below only enqueues
// (src/lib/pendingGdeltTitle.ts) candidates that clear GDELT's structural
// filters; drainPendingGdeltTitles fetches each one's REAL title directly
// from its own page (src/lib/articleTitleFetch.ts) and only THEN does it
// become a real RawItem, with the real title/snippet driving classify.ts's
// normal severity/category logic exactly like any other source. A
// candidate whose real title can't be fetched stays queued for retry
// (up to PENDING_GDELT_TITLE_MAX_AGE_MS) — never falls back to a guess.
//
// Only the Event table (export.CSV.zip) is fetched — the Mentions table
// isn't needed: the Event table's own SOURCEURL field already carries a
// real article URL per event.
const LAST_UPDATE_URL = "http://data.gdeltproject.org/gdeltv2/lastupdate.txt";
const REQUEST_TIMEOUT_MS = 20_000;

// How many queued candidates get a real-title-fetch attempt per ingest
// cycle. Each fetch is a real, potentially-slow external page load (up to
// articleTitleFetch.ts's own 8s timeout) — bounded concurrency and an
// overall deadline (see drainPendingGdeltTitles's caller in ingest.ts) keep
// this from eating the shared ingest time budget RSS/Telegram/etc. also
// need. At ~96 ingest cycles/day this still allows well over 1,000 title
// fetch attempts/day, comfortably ahead of realistic conflict-tier CAMEO
// candidate volume.
const DRAIN_BATCH_SIZE = 12;
const DRAIN_CONCURRENCY = 4;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GDELT bulk fetch failed for ${url}: HTTP ${res.status}`);
  return res.text();
}

async function fetchAndUnzipCsv(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GDELT bulk fetch failed for ${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const unzipped = unzipSync(bytes);
  const entries = Object.values(unzipped);
  if (entries.length === 0) throw new Error(`GDELT bulk zip had no entries: ${url}`);
  return new TextDecoder("utf-8").decode(entries[0]);
}

// lastupdate.txt is three lines, one per file, each "<size> <md5> <url>" —
// order is always export, mentions, gkg (GDELT's own long-standing
// convention, unchanged since the 2.0 format's 2015 introduction).
async function getLatestExportCsvUrl(): Promise<string> {
  const text = await fetchText(LAST_UPDATE_URL);
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!firstLine) throw new Error("GDELT lastupdate.txt was empty");
  const url = firstLine.trim().split(/\s+/)[2];
  if (!url || !url.includes("export.CSV.zip")) {
    throw new Error(`GDELT lastupdate.txt's first line didn't look like an export.CSV.zip URL: "${firstLine}"`);
  }
  return url;
}

// YYYYMMDDHHMMSS (UTC, per the codebook) -> Date.
function parseDateAdded(dateAdded: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(dateAdded);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

// Field positions verified 2026-09-10 against GDELT's own column-labels
// reference (linwoodc3/gdelt2HeaderRows) cross-checked against the primary
// GDELT 2.0 Event Codebook's field descriptions — 61 columns, 0-indexed
// here since that's how the split array is addressed.
const COL = {
  actor1CountryCode: 7,
  actor1KnownGroupCode: 8,
  actor2CountryCode: 17,
  actor2KnownGroupCode: 18,
  eventRootCode: 28,
  actionGeoCountryCode: 53,
  actor1GeoCountryCode: 37,
  actor2GeoCountryCode: 45,
  dateAdded: 59,
  sourceUrl: 60,
};

// Discovers candidates from the latest bulk file and enqueues the ones
// worth pursuing — does NOT publish anything directly (see this file's
// header comment). Always returns [] to the caller; the real items come
// from drainPendingGdeltTitles below, once a real title exists.
export async function discoverGdeltCandidates(): Promise<RawItem[]> {
  const exportUrl = await getLatestExportCsvUrl();
  const csv = await fetchAndUnzipCsv(exportUrl);

  const candidates: { url: string; resolvedCountry: string; publishedAt: Date }[] = [];
  const seenUrls = new Set<string>();

  for (const line of csv.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = line.split("\t");
    if (f.length < 61) continue; // malformed/truncated row — skip rather than guess

    const sourceUrl = f[COL.sourceUrl]?.trim();
    if (!sourceUrl || !/^https?:\/\//.test(sourceUrl) || seenUrls.has(sourceUrl)) continue;

    if (!isWorthFetchingRealTitle(f[COL.eventRootCode]?.trim() ?? "")) continue;

    // Requires at least one actor to be a real state/political/organizational
    // entity — a populated Actor_CountryCode (the actor's CAMEO political
    // affiliation, NOT the geographic location field below) or a
    // KnownGroupCode (a named IGO/NGO/rebel/terror organization with its own
    // CAMEO code) — added 2026-09-10 after live-testing surfaced GDELT's
    // well-known automated-coding noise: generic TABARI actor-TYPE labels
    // like "Criminal", "Serial Killer", "Firefighter", "Illegal Immigrant"
    // (used when GDELT can't identify a specific named entity) were getting
    // CAMEO-coded as ASSAULT/FIGHT root events from ordinary local
    // crime/human-interest content with zero geopolitical relevance. A real
    // government, military, named country, or organized political/armed
    // group will have one of these two fields populated; a generic role
    // match won't.
    const hasRealActor =
      Boolean(f[COL.actor1CountryCode]?.trim()) ||
      Boolean(f[COL.actor1KnownGroupCode]?.trim()) ||
      Boolean(f[COL.actor2CountryCode]?.trim()) ||
      Boolean(f[COL.actor2KnownGroupCode]?.trim());
    if (!hasRealActor) continue;

    // ActionGeo_CountryCode is this app's preferred field per the
    // codebook's own guidance (§ "When looking for events in or relating
    // to a specific country") — it captures the location of the ACTION
    // even when actor affiliations are blank/ambiguous ("unidentified
    // gunmen"), which is exactly the conflict-zone case this app cares
    // most about. Falls back to either actor's geo country if the action
    // itself has no geo match.
    const country =
      fipsToIso2(f[COL.actionGeoCountryCode]) ??
      fipsToIso2(f[COL.actor1GeoCountryCode]) ??
      fipsToIso2(f[COL.actor2GeoCountryCode]);
    if (!country) continue;

    const publishedAt = parseDateAdded(f[COL.dateAdded]);
    if (!publishedAt) continue;

    seenUrls.add(sourceUrl);
    candidates.push({ url: sourceUrl, resolvedCountry: country, publishedAt });
  }

  await enqueuePendingGdeltTitles(candidates).catch((err) => {
    console.error(`enqueuePendingGdeltTitles failed: ${err}`);
  });

  return [];
}

// Fetches real titles for a batch of previously-discovered candidates,
// turning each success into a real RawItem — this is the ONLY place a
// gdelt-sourced RawItem gets created now (see this file's header comment).
// A candidate whose fetch fails simply stays queued; nothing here ever
// falls back to a synthesized guess.
export async function drainPendingGdeltTitles(): Promise<RawItem[]> {
  await expireStalePendingGdeltTitles().catch((err) =>
    console.error(`expireStalePendingGdeltTitles failed: ${err}`),
  );

  const pending = await getPendingGdeltTitleBatch(DRAIN_BATCH_SIZE).catch(() => []);
  if (pending.length === 0) return [];

  const items: RawItem[] = [];
  const resolvedUrls: string[] = [];

  for (let start = 0; start < pending.length; start += DRAIN_CONCURRENCY) {
    const chunk = pending.slice(start, start + DRAIN_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (row) => ({ row, article: await fetchRealArticleTitle(row.url).catch(() => null) })),
    );
    for (const { row, article } of results) {
      if (!article) continue; // leave queued for retry next cycle
      resolvedUrls.push(row.url);
      items.push({
        source: "gdelt",
        url: row.url,
        title: article.title,
        snippet: article.snippet,
        publishedAt: row.publishedAt,
        resolvedCountry: row.resolvedCountry,
      });
    }
  }

  await deletePendingGdeltTitles(resolvedUrls).catch((err) =>
    console.error(`deletePendingGdeltTitles failed: ${err}`),
  );

  return items;
}
