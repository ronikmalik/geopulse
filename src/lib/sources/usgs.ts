import { resolveCountryFromText } from "@/lib/countryNames";
import type { DirectItem } from "./direct";

// USGS place strings end in a region after the last comma: "41 km SW of
// Karluk, Alaska", "5 km N of Ridgecrest, CA", "Timor Leste". The general
// news-text resolver knows countries, not US states, so on 2026-09-23 98
// of the 441 quakes in the scoring window (22%) carried no country —
// every one in Alaska among them. Mid-ocean ridges and open sea are
// correctly unplaceable and stay null; this table covers only regions
// USGS names that unambiguously belong to a country the app models.
const US_STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware",
  "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky",
  "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi",
  "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico",
  "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania",
  "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont",
  "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming",
];
// USGS uses postal abbreviations for its ComCat contributing networks
// ("Ridgecrest, CA"). As a two-letter code, "GA" is only ever the state.
const US_STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS",
  "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY",
  "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
  "WI", "WY",
]);
// "Georgia" is omitted from the full-name match: USGS writes the country
// as "Georgia" too, and a quake in the Caucasus is far likelier.
const US_STATE_NAMES = new Set(US_STATES.filter((s) => s !== "Georgia"));
const USGS_REGION_COUNTRY: Record<string, string> = {
  "Timor Leste": "TL",
  "Micronesia": "FM",
  "Puerto Rico": "PR",
};

export function usgsPlaceCountry(place: string): string | null {
  const suffix = place.slice(place.lastIndexOf(",") + 1).trim();
  const offCoast = /^off the coast of (.+)$/i.exec(suffix)?.[1];
  const region = offCoast ?? suffix;
  if (US_STATE_NAMES.has(region) || US_STATE_CODES.has(region)) return "US";
  if (USGS_REGION_COUNTRY[region]) return USGS_REGION_COUNTRY[region];
  return resolveCountryFromText(place);
}

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
        country: usgsPlaceCountry(place),
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
