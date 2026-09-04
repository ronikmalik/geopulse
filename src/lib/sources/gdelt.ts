import { Agent } from "undici";

export interface RawItem {
  source: string;
  url: string;
  title: string;
  snippet: string;
  publishedAt: Date;
}

const GDELT_DOC_ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";

// Node's global fetch (undici under the hood) has its own internal socket
// connect timeout, hardcoded to 10s by default and completely separate
// from AbortSignal.timeout() — raising the AbortSignal value does nothing
// for a slow/failed connect specifically (confirmed against undici's own
// issue tracker, not assumed). This app's production logs showed exactly
// that failure mode against GDELT specifically: "ConnectTimeoutError...
// timeout: 10000ms" — a dead giveaway it's undici's internal default
// firing, not our own timeoutMs. A live test from outside Vercel's network
// reached GDELT fine (got a real 429 back) in ~12s total, so the actual
// TCP/TLS handshake from Vercel's network is plausibly just slower than
// undici's 10s default allows, not a hard block — worth actually giving it
// room to complete instead of aborting every single attempt before it can.
// A dedicated dispatcher scoped to this module only (not a global
// override) keeps this fix targeted to the one source with evidence of
// this specific failure mode.
const gdeltDispatcher = new Agent({ connectTimeout: 20_000 });

interface GdeltArticle {
  url: string;
  title: string;
  seendate: string; // e.g. "20260823T120000Z"
  domain: string;
  sourcecountry: string;
}

function parseGdeltDate(seendate: string): Date {
  // Format: YYYYMMDDTHHMMSSZ
  const iso = seendate.replace(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
    "$1-$2-$3T$4:$5:$6Z",
  );
  const d = new Date(iso);
  return isNaN(d.getTime()) ? new Date() : d;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A live curl test against GDELT (independent of this app, 2026-09-04)
// took ~11-13s just to get a response back (a 429) under real load —
// well past the 7s this was originally set to. This default only applies
// outside ingest.ts's own fan-out (e.g. ad-hoc calls); ingest.ts passes
// its own tighter timeoutMs, sized to fit cron-job.org's hard 30s request
// timeout across a small rotating batch of categories per cycle rather
// than all 7 every time (see the comment there for why).
const REQUEST_TIMEOUT_MS = 15_000;

export async function fetchGdelt(
  query: string,
  maxRecords = 20,
  retries = 1,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<RawItem[]> {
  const params = new URLSearchParams({
    query,
    mode: "ArtList",
    maxrecords: String(maxRecords),
    sort: "DateDesc",
    format: "json",
    timespan: "3h",
  });

  let res: Response;
  try {
    res = await fetch(`${GDELT_DOC_ENDPOINT}?${params.toString()}`, {
      headers: { "User-Agent": "geopulse-globe/1.0" },
      signal: AbortSignal.timeout(timeoutMs),
      // Not in the standard fetch types (dispatcher is a Node/undici
      // extension) — see gdeltDispatcher above for why this is needed.
      dispatcher: gdeltDispatcher,
    } as RequestInit);
  } catch (err) {
    // Network-level failure (DNS, connect timeout, reset) rather than a
    // non-2xx response — err.cause carries the real reason, which the
    // default Error stringification drops.
    const cause = err instanceof Error && err.cause ? ` (${err.cause})` : "";
    if (retries > 0) {
      await sleep(1500);
      return fetchGdelt(query, maxRecords, retries - 1, timeoutMs);
    }
    throw new Error(`GDELT request failed for "${query}": ${err}${cause}`);
  }

  if (res.status === 429 && retries > 0) {
    await sleep(2000);
    return fetchGdelt(query, maxRecords, retries - 1, timeoutMs);
  }

  // Was previously "return []" here — silently indistinguishable from "GDELT
  // has no news right now" in source_health (see recordSourceHealth: a
  // non-throwing result marks lastSuccessAt/lastItemCount as if the cycle
  // genuinely succeeded). Direct testing (2026-09-04) found the real GDELT
  // free-tier behavior doesn't match its own stated "one request every 5
  // seconds": a single 429 appears to trigger a materially longer, sticky
  // cooldown — repeat single requests spaced 6s, then tens of seconds apart
  // kept getting 429 well past what 5s spacing alone would predict, matching
  // an independent report (github.com/alex9smith/gdelt-doc-api issue #22:
  // "roughly 60 requests over 90 minutes was enough to trigger a block that
  // no useful retry interval cleared"). Worse, this app runs on Vercel's
  // Hobby-tier shared, dynamic outbound-IP pool (confirmed via Vercel's own
  // networking docs) — not a per-project static IP — so an unrelated
  // tenant's traffic sharing the same egress IP can trigger a block this
  // app never caused itself, no matter how conservative ingest.ts's own
  // rotation/spacing is. Throwing here (instead of swallowing) makes that
  // visible in source_health as a real error instead of a silently "clean"
  // empty cycle — the honest state, not a fixable-by-more-backoff one.
  // GDELT's own recommended fix for genuine high-volume use (their Web
  // NGrams 3.0 downloadable dataset) doesn't fit this app's small periodic
  // per-category query shape, so intermittent GDELT gaps are accepted as a
  // real constraint, backstopped by RSS's continuous coverage of the same
  // flashpoint categories (see ingest.ts) — not something worth chasing
  // further with tighter retry logic.
  if (!res.ok) {
    const detail =
      res.status === 429
        ? "429 rate limited (see comment above — likely Vercel's shared egress IP, not this app's own request volume)"
        : `HTTP ${res.status}`;
    throw new Error(`GDELT request failed for "${query}": ${detail}`);
  }

  const text = await res.text();
  if (!text.trim()) return [];

  let data: { articles?: GdeltArticle[] };
  try {
    data = JSON.parse(text);
  } catch {
    console.error(`GDELT returned non-JSON for query "${query}"`);
    return [];
  }

  return (data.articles ?? []).map((a) => ({
    source: "gdelt",
    url: a.url,
    title: a.title,
    snippet: `${a.domain} (${a.sourcecountry})`,
    publishedAt: parseGdeltDate(a.seendate),
  }));
}
