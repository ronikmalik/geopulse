import { COUNTRY_CENTROIDS } from "./countryCentroids";

// Real per-story geocoding for RSS/Telegram events, added 2026-09-09.
// classify.ts's classifyByKeywords only ever resolves which COUNTRY a
// story is about — it has no location-extraction step, so every
// RSS/Telegram event's lat/lon was hard-coded to that country's centroid
// (COUNTRY_CENTROIDS). Verified live 2026-09-09: 86 of the 100 most
// recent Russia events all shared the exact same coordinate (Moscow),
// stacking dozens of genuinely distinct stories into one indistinguishable
// globe marker — user-reported ("why does Russia only ever show one
// pulse"). This module is the fix: a best-effort Gemini pass (the same
// free-tier gemini-3.5-flash-lite already used by classifierAudit.ts and
// countryBriefs.ts — same GEMINI_API_KEY, same quota pool, no new account
// or cost) that reads the title/snippet plus the country classify.ts
// already resolved, and returns a specific place name + coordinate. Run
// as a decoupled backfill pass (see geocodeBackfill.ts) after the event
// is already live — same "never block the insert path on an enrichment
// call" posture as embeddingBackfill.ts.
//
// Deliberately scoped to location only, not a second classification pass:
// classify.ts's relevance/category/severity gate is the product of months
// of keyword tuning (BENIGN_PATTERNS, MIN_SEVERITY_TO_INCLUDE, etc., all
// documented in classify.ts) — reusing an LLM to re-decide any of that
// risks quietly regressing it. This asks Gemini nothing except "where,
// specifically" for an item already judged relevant.
const GEOCODE_MODEL = process.env.GEMINI_GEOCODE_MODEL || "gemini-3.5-flash-lite";
const GENERATE_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEOCODE_MODEL}:generateContent`;
const REQUEST_TIMEOUT_MS = 20_000;
const SNIPPET_CHARS = 300;

// Same model/quota pool as classifierAudit.ts and countryBriefs.ts (see
// their own doc comments for the live-checked 15 RPM / 500 RPD free-tier
// numbers). src/lib/ingest.ts's runGeminiAuditChain runs this
// sequentially after both of those, never concurrently — two
// independently-paced callers of the same model still stacked past 15
// RPM in production on 2026-09-08 (see that comment), so a third caller
// joins the same single-file queue rather than its own parallel one.
export const GEOCODE_BATCH_SIZE = 20;

export interface GeocodeCandidate {
  id: number;
  title: string;
  snippet: string;
  country: string; // ISO 3166-1 alpha-2, already resolved by classify.ts
}

export interface GeocodeResult {
  location: string;
  lat: number;
  lon: number;
}

interface RawGeocodeItem {
  id?: unknown;
  location?: unknown;
  lat?: unknown;
  lon?: unknown;
}

// Great-circle distance in km — a cheap sanity check against a
// hallucinated coordinate outside the country Gemini itself was told the
// story is about (e.g. drifting to a same-named place on a different
// continent). Doesn't need to be precise, just needs to reject "obviously
// not this country" answers.
function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
// Generous enough to cover the largest countries (Russia spans ~9000km
// east-west) without needing real border polygons — this is a
// hallucination guard, not a precision check.
const MAX_PLAUSIBLE_KM_FROM_CENTROID = 5000;

function buildPrompt(batch: GeocodeCandidate[]): string {
  const lines = batch.map(
    (c) =>
      `[${c.id}] COUNTRY: ${c.country}\nTITLE: ${c.title}\nCONTEXT: ${c.snippet.slice(0, SNIPPET_CHARS)}`,
  );
  return (
    "For each numbered news item below, identify the SPECIFIC real-world place (city/region — not just the country, which is already given and correct) the event is centered on, and its approximate latitude/longitude. " +
    "Do not change or second-guess the given country — only locate the event within it as precisely as the text allows. " +
    "If the text names no specific place, use the country's capital as your best estimate rather than skipping the item. " +
    'Respond with a JSON array only, one object per item, no other text: [{"id": <number>, "location": "<City, Country>", "lat": <number>, "lon": <number>}, ...]\n\n' +
    lines.join("\n\n")
  );
}

async function callGemini(prompt: string, apiKey: string): Promise<RawGeocodeItem[] | null> {
  let res: Response;
  try {
    res = await fetch(`${GENERATE_ENDPOINT}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`Geocode request failed: ${err}`);
    return null;
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(`Geocode fetch failed: ${res.status} ${errBody.slice(0, 200)}`);
    return null;
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    console.error(`Geocode JSON parse failed: ${err}`);
    return null;
  }
}

// Resolves one batch (a single Gemini call, up to GEOCODE_BATCH_SIZE
// items) — caller (geocodeBackfill.ts) owns chunking/pacing/deadlines
// across multiple calls, same division of responsibility as
// classifierAudit.ts's processKeptCandidates/callGeminiJson split.
//
// Return value distinguishes two failure shapes the caller needs to
// treat differently: `null` means the WHOLE call failed (network error,
// timeout, bad JSON) — every item should be retried next cycle. A
// non-null Map that's simply missing some ids means the call succeeded
// but those specific items didn't produce a usable answer (failed
// validation, or Gemini omitted them) — the caller treats those as a
// permanent give-up (stays on the country-centroid fallback) rather than
// retrying forever, the same "per-item null is expected, don't waste the
// rest of the batch over it" posture as embeddings.ts's embedBatch.
export async function resolveLocationsBatch(
  batch: GeocodeCandidate[],
  apiKey: string,
): Promise<Map<number, GeocodeResult> | null> {
  if (batch.length === 0) return new Map();

  const raw = await callGemini(buildPrompt(batch), apiKey);
  if (!raw) return null;

  const byId = new Map(batch.map((c) => [c.id, c]));
  const results = new Map<number, GeocodeResult>();

  for (const item of raw) {
    if (typeof item.id !== "number") continue;
    const candidate = byId.get(item.id);
    if (!candidate) continue;
    if (typeof item.lat !== "number" || typeof item.lon !== "number") continue;
    if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) continue;
    if (item.lat < -90 || item.lat > 90 || item.lon < -180 || item.lon > 180) continue;
    if (typeof item.location !== "string" || !item.location) continue;

    const centroid = COUNTRY_CENTROIDS[candidate.country];
    if (centroid) {
      const distanceKm = haversineKm(centroid.lat, centroid.lon, item.lat, item.lon);
      // Hallucinated/wrong-country guess — keep the existing centroid
      // fallback for this one item instead of trusting a wild answer.
      if (distanceKm > MAX_PLAUSIBLE_KM_FROM_CENTROID) continue;
    }

    results.set(item.id, { location: item.location, lat: item.lat, lon: item.lon });
  }
  return results;
}
