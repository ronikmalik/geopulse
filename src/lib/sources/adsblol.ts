// adsb.lol live ADS-B aircraft tracking, no API key required. Powers two
// distinct layers: /v2/mil (military — a curated feed, not filterable by
// query) for the "flights" layer, and several /v2/point/{lat}/{lon}/{radius}
// hub queries merged together (see fetchAdsbLolCommercial below) for the
// "commercial-flights" layer.
// https://api.adsb.lol/docs
const ADSBLOL_MIL_ENDPOINT = "https://api.adsb.lol/v2/mil";
const ADSBLOL_POINT_ENDPOINT = "https://api.adsb.lol/v2/point";

export interface TrackedAircraft {
  hex: string;
  flight: string | null;
  registration: string | null;
  type: string | null;
  category: string | null;
  lat: number;
  lon: number;
  altitudeFt: number | null;
  groundSpeedKt: number | null;
  trackDeg: number | null;
}

interface AdsbLolAircraft {
  hex: string;
  flight?: string;
  r?: string;
  t?: string;
  category?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  gs?: number;
  track?: number;
}

interface AdsbLolResponse {
  ac: AdsbLolAircraft[];
}

function toTrackedAircraft(
  raw: AdsbLolAircraft[],
): TrackedAircraft[] {
  return raw
    .filter(
      (a): a is AdsbLolAircraft & { lat: number; lon: number } =>
        typeof a.lat === "number" && typeof a.lon === "number",
    )
    .map((a) => ({
      hex: a.hex,
      flight: a.flight?.trim() || null,
      registration: a.r ?? null,
      type: a.t ?? null,
      category: a.category ?? null,
      lat: a.lat,
      lon: a.lon,
      altitudeFt: typeof a.alt_baro === "number" ? a.alt_baro : null,
      groundSpeedKt: a.gs ?? null,
      trackDeg: a.track ?? null,
    }));
}

async function fetchAdsbLol(url: string): Promise<AdsbLolAircraft[]> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "geopulse-globe/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(`adsb.lol request failed: ${err}`);
  }
  if (!res.ok) {
    // Thrown, not swallowed as [] (2026-09-20): a 429/5xx must look like a
    // failure to callers, so the commercial hub loop can retry it and the
    // snapshot can refuse to record an undercount.
    throw new Error(`adsb.lol fetch failed: ${res.status}`);
  }
  const data = (await res.json()) as AdsbLolResponse;
  return data.ac ?? [];
}

export async function fetchAdsbLolMilitary(): Promise<TrackedAircraft[]> {
  return toTrackedAircraft(await fetchAdsbLol(ADSBLOL_MIL_ENDPOINT));
}

// adsb.lol has no single "all commercial traffic globally" endpoint the way
// OpenSky's /states/all aimed to be (this app used OpenSky for that exact
// reason until 2026-09) — its point/radius query caps at 250nm, too small
// to cover a bounding box the size of "Europe/Middle East" in one call.
// Confirmed live 2026-09-09: OpenSky's endpoint was blocked/empty from
// Vercel's shared outbound IP (same pattern already diagnosed for GDELT
// and this app's own military-flights route before it switched providers),
// while adsb.lol's point endpoint returned real aircraft immediately from
// the same environment. Rather than one big query, this samples several
// geopolitically dense airspace hubs and merges the results — a curated
// snapshot of busy/contested airspace, not a true global bounding box, but
// real live data beats an empty layer.
const COMMERCIAL_HUBS: { lat: number; lon: number }[] = [
  { lat: 51.5, lon: -0.12 }, // London
  { lat: 50.03, lon: 8.57 }, // Frankfurt
  { lat: 41.28, lon: 28.75 }, // Istanbul — NATO/Black Sea/Middle East crossroads
  { lat: 25.2, lon: 55.27 }, // Dubai — Gulf air corridor
  { lat: 32.08, lon: 34.78 }, // Tel Aviv
  { lat: 55.75, lon: 37.62 }, // Moscow
  { lat: 38.9, lon: -77.04 }, // Washington DC
  { lat: 22.3, lon: 114.17 }, // Hong Kong — Taiwan Strait approach
  { lat: 37.57, lon: 126.98 }, // Seoul
];
const COMMERCIAL_RADIUS_NM = 250;

// Hubs are queried ONE AT A TIME, not in parallel (2026-09-20): nine
// simultaneous requests tripped adsb.lol's rate limit and the 429'd hub
// silently contributed zero aircraft. For the live layer that is a
// cosmetic gap; for the daily snapshot (flightBaseline.ts) it is a
// phantom "airspace closure" — the commercial signal is the one that
// flags large DROPS, so a random 429 looks exactly like the event it
// exists to detect.
//
// Probed live 2026-09-20 from a residential IP: the limit behaves like a
// small token bucket — a burst of 3-4 succeeds, then 429s until it
// refills over a few seconds, and even 1 request/second is not reliably
// clean once the bucket is drained. So: one second between hubs, and a
// 429 is retried with a growing pause (3s, 6s, 12s). The live layer route
// gets one retry (it sits behind a 20s cache and a serverless clock); the
// snapshot passes `strict` for the full three, and a hub that STILL fails
// throws so the day is recorded as an error rather than an undercount.
const HUB_SPACING_MS = 1_000;
const RETRY_BACKOFF_MS = [3_000, 6_000, 12_000];

export async function fetchAdsbLolCommercial(options: { strict?: boolean } = {}): Promise<TrackedAircraft[]> {
  const maxRetries = options.strict ? RETRY_BACKOFF_MS.length : 1;
  const batches: AdsbLolAircraft[][] = [];
  for (const [i, h] of COMMERCIAL_HUBS.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, HUB_SPACING_MS));
    const url = `${ADSBLOL_POINT_ENDPOINT}/${h.lat}/${h.lon}/${COMMERCIAL_RADIUS_NM}`;
    let batch: AdsbLolAircraft[] | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= maxRetries && batch === null; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt - 1]));
      batch = await fetchAdsbLol(url).catch((err) => {
        lastError = err;
        return null;
      });
    }
    if (batch === null) {
      const msg = `adsb.lol commercial hub (${h.lat},${h.lon}) unavailable after ${maxRetries} retr${maxRetries === 1 ? "y" : "ies"}: ${lastError}`;
      if (options.strict) throw new Error(msg);
      console.error(msg);
      continue;
    }
    batches.push(batch);
  }

  // Adjacent hubs' 250nm radii can overlap (e.g. London/Frankfurt) — dedupe
  // by hex so an aircraft in the overlap isn't double-plotted.
  const byHex = new Map<string, AdsbLolAircraft>();
  for (const batch of batches) {
    for (const a of batch) byHex.set(a.hex, a);
  }
  return toTrackedAircraft([...byHex.values()]);
}
