import { resolveCountryFromText } from "@/lib/countryNames";
import type { DirectItem } from "./direct";

// Significant-magnitude, rolling 24h window — no API key required.
// https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php
const USGS_FEED =
  "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson";

// FDSN Event Web Service — the same underlying catalog, queryable over an
// arbitrary historical date range rather than just "last N days". Used for
// backfill (src/lib/backfill.ts), not live ingestion.
// https://earthquake.usgs.gov/fdsnws/event/1/
const USGS_FDSN_ENDPOINT = "https://earthquake.usgs.gov/fdsnws/event/1/query";

interface UsgsFeature {
  id: string;
  properties: {
    mag: number | null;
    place: string | null;
    time: number;
    url: string;
    title: string;
    tsunami: number;
  };
  geometry: { type: string; coordinates: [number, number, number] } | null;
}

interface UsgsResponse {
  features: UsgsFeature[];
}

function magnitudeSeverity(mag: number): number {
  if (mag >= 7) return 5;
  if (mag >= 6) return 4;
  if (mag >= 5.5) return 3;
  if (mag >= 5) return 2;
  return 1;
}

function mapFeatures(features: UsgsFeature[]): DirectItem[] {
  return features
    .filter(
      (f): f is UsgsFeature & { geometry: NonNullable<UsgsFeature["geometry"]> } =>
        f.properties.mag != null && f.geometry != null,
    )
    .map((f) => {
      const [lon, lat] = f.geometry.coordinates;
      const mag = f.properties.mag as number;
      const place = f.properties.place ?? "Unknown location";
      const tsunamiNote = f.properties.tsunami
        ? " — tsunami warning issued"
        : "";
      return {
        source: "usgs",
        url: f.properties.url,
        title: f.properties.title,
        summary: `Magnitude ${mag.toFixed(1)} earthquake ${place}${tsunamiNote}.`,
        category: "earthquake",
        location: place,
        country: resolveCountryFromText(place),
        lat,
        lon,
        severity: magnitudeSeverity(mag),
        publishedAt: new Date(f.properties.time),
      };
    });
}

export async function fetchUsgsEarthquakes(): Promise<DirectItem[]> {
  let res: Response;
  try {
    res = await fetch(USGS_FEED, {
      headers: { "User-Agent": "geopulse-globe/1.0" },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (err) {
    throw new Error(`USGS request failed: ${err}`);
  }

  if (!res.ok) {
    console.error(`USGS fetch failed: ${res.status}`);
    return [];
  }

  const data = (await res.json()) as UsgsResponse;
  return mapFeatures(data.features);
}

// Backfill only — pulls the full M4.5+ catalog for an arbitrary window
// (verified against the live FDSN endpoint: ~600+ events for a 30-day
// global window, well within one response with no pagination needed).
export async function fetchUsgsEarthquakesHistorical(
  daysBack: number,
): Promise<DirectItem[]> {
  const end = new Date();
  const start = new Date(end.getTime() - daysBack * 86_400_000);
  const params = new URLSearchParams({
    format: "geojson",
    starttime: start.toISOString().slice(0, 10),
    endtime: end.toISOString().slice(0, 10),
    minmagnitude: "4.5",
  });

  let res: Response;
  try {
    res = await fetch(`${USGS_FDSN_ENDPOINT}?${params.toString()}`, {
      headers: { "User-Agent": "geopulse-globe/1.0" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(`USGS historical request failed: ${err}`);
  }

  if (!res.ok) {
    console.error(`USGS historical fetch failed: ${res.status}`);
    return [];
  }

  const data = (await res.json()) as UsgsResponse;
  return mapFeatures(data.features);
}
