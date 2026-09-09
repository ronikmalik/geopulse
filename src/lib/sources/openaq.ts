import { DEFAULT_MONITORED_LOCATIONS, type MonitoredLocation } from "./openmeteo";

// OpenAQ v3 — ground-station PM2.5 readings for the same fixed capitals
// Open-Meteo already monitors (src/lib/sources/openmeteo.ts), reusing that
// list rather than inventing a second one so both layers describe the same
// cities. Display-only context (per the product decision this was built
// under): raw µg/m³ is shown as-is, with no AQI conversion, since AQI
// breakpoints differ by country (US EPA vs EU vs India all disagree) and
// picking one would misrepresent readings from everywhere else — same
// "let the consumer define severity" restraint openmeteo.ts already
// documents for weather codes. Not fed into the risk model.
//
// Unlike every other optional-key source in this app, v3 requires the key
// for EVERY request, including a bare GET with no auth at all (verified
// live 2026-09-08: an unauthenticated request 401s with "A valid API key
// must be provided in the X-API-Key header" — there's no unauthenticated
// preview tier the way FIRMS/Google Translate have). Soft no-op without
// one regardless, same as those two: this ships now and activates the
// moment OPENAQ_API_KEY is set.
//
// Data is CC BY 4.0 (openaq.org licenses page) — commercial use is fine
// with attribution; individual station licenses can vary and aren't
// checked per-station here, same "aggregate policy, not every source
// individually re-verified" treatment already given to CFTC/World Bank.
const OPENAQ_BASE = "https://api.openaq.org/v3";
const SEARCH_RADIUS_M = 25_000; // API max is 25,000m
const REQUEST_TIMEOUT_MS = 10_000;

export interface AirQualityReading {
  location: MonitoredLocation;
  pm25: number | null; // µg/m³, null if no PM2.5 sensor found nearby
  unit: string;
  stationName: string | null;
  observedAt: Date | null;
}

interface OpenAqSensor {
  id: number;
  parameter: { name: string; units: string };
}

interface OpenAqLocation {
  id: number;
  name: string | null;
  sensors: OpenAqSensor[];
}

interface OpenAqLocationsResponse {
  results: OpenAqLocation[];
}

interface OpenAqLatestResult {
  value: number;
  sensorsId: number;
  datetime: { utc: string };
}

interface OpenAqLatestResponse {
  results: OpenAqLatestResult[];
}

async function fetchJson<T>(url: string, apiKey: string): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "X-API-Key": apiKey, "User-Agent": "geopulse-globe/1.0" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`OpenAQ request failed: ${err}`);
    return null;
  }
  if (!res.ok) {
    console.error(`OpenAQ fetch failed: ${res.status}`);
    return null;
  }
  return (await res.json()) as T;
}

async function fetchOneLocation(
  loc: MonitoredLocation,
  apiKey: string,
): Promise<AirQualityReading> {
  const empty: AirQualityReading = {
    location: loc,
    pm25: null,
    unit: "µg/m³",
    stationName: null,
    observedAt: null,
  };

  const searchParams = new URLSearchParams({
    coordinates: `${loc.lat},${loc.lon}`,
    radius: String(SEARCH_RADIUS_M),
    limit: "5",
  });
  const locations = await fetchJson<OpenAqLocationsResponse>(
    `${OPENAQ_BASE}/locations?${searchParams.toString()}`,
    apiKey,
  );
  if (!locations || locations.results.length === 0) return empty;

  // First nearby station (results are distance-ordered) that actually runs
  // a pm25 sensor — a location with only e.g. ozone/NO2 sensors is no use
  // here.
  let station: OpenAqLocation | undefined;
  let sensor: OpenAqSensor | undefined;
  for (const candidate of locations.results) {
    const pm25Sensor = candidate.sensors.find((s) => s.parameter.name === "pm25");
    if (pm25Sensor) {
      station = candidate;
      sensor = pm25Sensor;
      break;
    }
  }
  if (!station || !sensor) return empty;

  const latest = await fetchJson<OpenAqLatestResponse>(
    `${OPENAQ_BASE}/locations/${station.id}/latest`,
    apiKey,
  );
  const reading = latest?.results.find((r) => r.sensorsId === sensor!.id);
  if (!reading) return empty;

  return {
    location: loc,
    pm25: reading.value,
    unit: sensor.parameter.units,
    stationName: station.name,
    observedAt: new Date(reading.datetime.utc),
  };
}

export async function fetchAirQuality(
  locations: MonitoredLocation[] = DEFAULT_MONITORED_LOCATIONS,
): Promise<AirQualityReading[]> {
  const apiKey = process.env.OPENAQ_API_KEY;
  if (!apiKey) return [];

  // 12 locations x 2 calls each (locations search + latest) per refresh —
  // small enough for OpenAQ's "generous" per-key rate limit (exact numbers
  // aren't published; the API exposes X-RateLimit-* response headers to
  // self-monitor if this ever needs tightening) even run concurrently.
  return Promise.all(locations.map((loc) => fetchOneLocation(loc, apiKey)));
}
