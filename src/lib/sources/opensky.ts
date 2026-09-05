import type { TrackedAircraft } from "./adsblol";

// OpenSky Network live global flight states, no API key required for
// anonymous access — but anonymous requests MUST scope to a bounding box
// or they get rate-limited/blocked, unlike adsb.lol's military-only feed.
// https://openskynetwork.github.io/opensky-api/rest.html
const OPENSKY_STATES_ENDPOINT = "https://opensky-network.org/api/states/all";

export interface BoundingBox {
  lamin: number;
  lomin: number;
  lamax: number;
  lomax: number;
}

// Europe/Middle East — a geopolitically dense slice of airspace, used when
// no bbox is supplied.
export const DEFAULT_BBOX: BoundingBox = {
  lamin: 25,
  lomin: -10,
  lamax: 60,
  lomax: 60,
};

// Positional array per OpenSky's REST spec:
// [icao24, callsign, origin_country, time_position, last_contact,
//  longitude, latitude, baro_altitude, on_ground, velocity, true_track,
//  vertical_rate, sensors, geo_altitude, squawk, spi, position_source]
type OpenSkyState = [
  string,
  string | null,
  string,
  number | null,
  number,
  number | null,
  number | null,
  number | null,
  boolean,
  number | null,
  number | null,
  number | null,
  number[] | null,
  number | null,
  string | null,
  boolean,
  number,
];

interface OpenSkyResponse {
  time: number;
  states: OpenSkyState[] | null;
}

export async function fetchOpenSkyStates(
  bbox: BoundingBox = DEFAULT_BBOX,
): Promise<TrackedAircraft[]> {
  const params = new URLSearchParams({
    lamin: String(bbox.lamin),
    lomin: String(bbox.lomin),
    lamax: String(bbox.lamax),
    lomax: String(bbox.lomax),
  });

  let res: Response;
  try {
    res = await fetch(`${OPENSKY_STATES_ENDPOINT}?${params.toString()}`, {
      headers: { "User-Agent": "geopulse-globe/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(`OpenSky request failed: ${err}`);
  }

  // Was previously "console.error + return []" here — indistinguishable
  // from "genuinely zero aircraft over Europe/Middle East right now",
  // which never happens for a live bounding box this size. Confirmed live
  // (2026-09-04): a direct request from outside Vercel got real aircraft
  // data back immediately, while this app's own deployed route kept
  // returning an empty array — the same Vercel-shared-outbound-IP pattern
  // already diagnosed for GDELT's 429s. Throwing here lets the route
  // catch it and surface a real `error` field instead of silently
  // reporting "0 aircraft tracked" as if that were a normal live reading.
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenSky fetch failed: ${res.status} ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as OpenSkyResponse;

  return (data.states ?? [])
    .filter(
      (s): s is OpenSkyState & { 5: number; 6: number } =>
        typeof s[5] === "number" && typeof s[6] === "number",
    )
    .map((s) => ({
      hex: s[0],
      flight: s[1]?.trim() || null,
      registration: null,
      type: null,
      // TrackedAircraft.category is repurposed here to carry the flight's
      // origin country — OpenSky doesn't expose an aircraft category, but
      // adsb.lol's shape has no country field to reuse instead.
      category: s[2],
      lat: s[6],
      lon: s[5],
      altitudeFt: typeof s[7] === "number" ? Math.round(s[7] * 3.28084) : null,
      groundSpeedKt: typeof s[9] === "number" ? Math.round(s[9] * 1.94384) : null,
      trackDeg: s[10],
    }));
}
