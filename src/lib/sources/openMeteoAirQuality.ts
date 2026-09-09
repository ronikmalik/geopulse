// Open-Meteo Air Quality API — no key required, unlike openaq.ts (kept in
// this repo as a standalone/not-integrated source; see its own header for
// why v3 needs a key for every request with no free preview tier). This
// app's air-quality layer switched to this endpoint 2026-09-09 after
// confirming live in production that OPENAQ_API_KEY had never actually
// been configured, so that layer had been silently returning zero readings
// since it shipped. Model-estimated (satellite/reanalysis-blended), not a
// ground station reading — display-only here regardless, same "let the
// consumer define severity" restraint openmeteo.ts documents for weather
// codes, so that distinction doesn't change how this app uses the number.
// https://open-meteo.com/en/docs/air-quality-api
import {
  DEFAULT_MONITORED_LOCATIONS,
  type MonitoredLocation,
} from "./openmeteo";

const AIR_QUALITY_ENDPOINT = "https://air-quality-api.open-meteo.com/v1/air-quality";

export interface AirQualityReading {
  location: MonitoredLocation;
  pm25: number | null;
  unit: string;
  stationName: string | null;
  observedAt: Date | null;
}

interface OpenMeteoAirQualityResponse {
  current?: {
    time: string;
    pm2_5: number | null;
  };
}

export async function fetchAirQuality(
  locations: MonitoredLocation[] = DEFAULT_MONITORED_LOCATIONS,
): Promise<AirQualityReading[]> {
  const params = new URLSearchParams({
    latitude: locations.map((l) => l.lat).join(","),
    longitude: locations.map((l) => l.lon).join(","),
    current: "pm2_5",
  });

  let res: Response;
  try {
    res = await fetch(`${AIR_QUALITY_ENDPOINT}?${params.toString()}`, {
      headers: { "User-Agent": "geopulse-globe/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(`Open-Meteo air quality request failed: ${err}`);
  }

  if (!res.ok) {
    console.error(`Open-Meteo air quality fetch failed: ${res.status}`);
    return [];
  }

  const data = (await res.json()) as OpenMeteoAirQualityResponse[];

  // Same request-order response shape as openmeteo.ts's weather endpoint.
  return data.map((entry, i) => ({
    location: locations[i],
    pm25: entry.current?.pm2_5 ?? null,
    unit: "µg/m³",
    stationName: null,
    observedAt: entry.current ? new Date(`${entry.current.time}:00Z`) : null,
  }));
}
