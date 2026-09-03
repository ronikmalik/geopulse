export interface RawItem {
  source: string;
  url: string;
  title: string;
  snippet: string;
  publishedAt: Date;
}

const GDELT_DOC_ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";

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

// Bounded so the category queries in ingest.ts (run in parallel, one
// retry each on network failure) can't stall the whole ingest run for
// long if GDELT is slow or unreachable — a dead endpoint should fail
// fast enough that RSS and everything else still gets a fair chance to
// run within the ingest route's overall budget.
const REQUEST_TIMEOUT_MS = 7_000;

export async function fetchGdelt(
  query: string,
  maxRecords = 20,
  retries = 1,
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Network-level failure (DNS, connect timeout, reset) rather than a
    // non-2xx response — err.cause carries the real reason, which the
    // default Error stringification drops.
    const cause = err instanceof Error && err.cause ? ` (${err.cause})` : "";
    if (retries > 0) {
      await sleep(1500);
      return fetchGdelt(query, maxRecords, retries - 1);
    }
    throw new Error(`GDELT request failed for "${query}": ${err}${cause}`);
  }

  if (res.status === 429 && retries > 0) {
    await sleep(2000);
    return fetchGdelt(query, maxRecords, retries - 1);
  }

  if (!res.ok) {
    console.error(`GDELT fetch failed: ${res.status} for query "${query}"`);
    return [];
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
