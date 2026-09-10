import { unzipSync } from "fflate";
import type { RawItem } from "./gdelt";
import { fipsToIso2 } from "../fipsCountryCodes";
import { buildEventDescription } from "../cameoEventCodes";

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
// Only the Event table (export.CSV.zip) is fetched — the Mentions table
// (mentions.CSV.zip) is NOT needed for this app's purposes: the Event
// table's own SOURCEURL field already carries a real article URL per event,
const LAST_UPDATE_URL = "http://data.gdeltproject.org/gdeltv2/lastupdate.txt";
const REQUEST_TIMEOUT_MS = 20_000;

// NumSources/NumMentions were tried as a quality gate (require >=2
// independent sources before trusting an event) and live-tested against a
// real production file (2026-09-10): they DON'T work as one — NumSources is
// frozen at the value from the 15-minute window an event was FIRST seen, so
// almost every event reads as NumSources=1 the moment it enters the file by
// construction (only 25 of 1,148 real events in a live test window had
// NumSources>=2). Worse, requiring multi-source pickup within the same
// 15-minute window would selectively reject exactly the smaller/less-
// prominent-country stories this whole rewrite exists to surface, since a
// major-country story is far more likely to get picked up by several
// outlets within 15 minutes than an obscure one is. No pre-filter on
// source count is applied here — classify.ts's own downstream gates
// (severity floor, NON_EVENT/EDITORIAL/RHETORICAL pattern checks,
// isLikelyGeopolitical) plus eventDedup.ts's cross-outlet merging are what
// actually manage quality/corroboration, the same as for every other
// source this app ingests.

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

function parseFloatSafe(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Field positions verified 2026-09-10 against GDELT's own column-labels
// reference (linwoodc3/gdelt2HeaderRows) cross-checked against the primary
// GDELT 2.0 Event Codebook's field descriptions — 61 columns, 0-indexed
// here since that's how the split array is addressed.
const COL = {
  actor1Name: 6,
  actor1CountryCode: 7,
  actor1KnownGroupCode: 8,
  actor2Name: 16,
  actor2CountryCode: 17,
  actor2KnownGroupCode: 18,
  eventRootCode: 28,
  goldsteinScale: 30,
  numSources: 32,
  actionGeoType: 51,
  actionGeoFullName: 52,
  actionGeoCountryCode: 53,
  actor1GeoCountryCode: 37,
  actor2GeoCountryCode: 45,
  dateAdded: 59,
  sourceUrl: 60,
};

export async function fetchGdeltBulkEvents(): Promise<RawItem[]> {
  const exportUrl = await getLatestExportCsvUrl();
  const csv = await fetchAndUnzipCsv(exportUrl);

  const items: RawItem[] = [];
  const seenUrls = new Set<string>();

  for (const line of csv.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = line.split("\t");
    if (f.length < 61) continue; // malformed/truncated row — skip rather than guess

    const sourceUrl = f[COL.sourceUrl]?.trim();
    if (!sourceUrl || !/^https?:\/\//.test(sourceUrl) || seenUrls.has(sourceUrl)) continue;

    // Requires at least one actor to be a real state/political/organizational
    // entity — a populated Actor_CountryCode (the actor's CAMEO political
    // affiliation, NOT the geographic location field below) or a
    // KnownGroupCode (a named IGO/NGO/rebel/terror organization with its own
    // CAMEO code) — added 2026-09-10 after live-testing surfaced GDELT's
    // well-known automated-coding noise: generic TABARI actor-TYPE labels
    // like "Criminal", "Serial Killer", "Firefighter", "Illegal Immigrant"
    // (used when GDELT can't identify a specific named entity) were getting
    // CAMEO-coded as ASSAULT/FIGHT root events from ordinary local
    // crime/human-interest content with zero geopolitical relevance —
    // "Criminal is fighting in Flensburg, Germany" is not a security event,
    // it's a police-blotter item mis-extracted. A real government, military,
    // named country, or organized political/armed group will have one of
    // these two fields populated; a generic role match won't.
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

    const description = buildEventDescription({
      actor1Name: f[COL.actor1Name]?.trim() || null,
      actor2Name: f[COL.actor2Name]?.trim() || null,
      eventRootCode: f[COL.eventRootCode]?.trim() ?? "",
      goldsteinScale: parseFloatSafe(f[COL.goldsteinScale]),
      actionLocationName: f[COL.actionGeoFullName]?.trim() || null,
    });
    if (!description) continue;

    seenUrls.add(sourceUrl);
    items.push({
      source: "gdelt",
      url: sourceUrl,
      title: description.title,
      snippet: description.snippet,
      publishedAt,
      resolvedCountry: country,
    });
  }

  return items;
}
