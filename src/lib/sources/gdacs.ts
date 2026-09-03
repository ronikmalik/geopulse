import type { DirectItem } from "./direct";

// GDACS (Global Disaster Alert and Coordination System) — multi-hazard
// disaster feed with an official Green/Orange/Red alert level, no API key
// required. Earthquakes are excluded here since USGS already covers them
// with more precise magnitude/coordinates.
// https://www.gdacs.org/knowledge/rss.aspx
const GDACS_FEED = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH";

const EVENT_TYPE_LABELS: Record<string, string> = {
  TC: "Tropical Cyclone",
  FL: "Flood",
  DR: "Drought",
  VO: "Volcanic Activity",
  WF: "Wildfire",
  TS: "Tsunami",
};

const EXCLUDED_EVENT_TYPES = new Set(["EQ"]);

// Flood/drought/wildfire are climate-pillar hazards (per the blueprint's
// Climate & Environment pillar); cyclone/volcano/tsunami are physical
// hazard-pillar events (Natural & Biological Hazards) — see
// src/lib/pillars.ts. Anything not listed here defaults to the hazards
// pillar via "natural-disaster".
const CLIMATE_EVENT_TYPES = new Set(["FL", "DR", "WF"]);

interface GdacsFeature {
  geometry: { type: string; coordinates: [number, number] } | null;
  properties: {
    eventtype: string;
    name: string;
    description: string | null;
    alertlevel: "Green" | "Orange" | "Red" | string;
    fromdate: string;
    url?: { report?: string };
    affectedcountries?: { iso2: string; countryname: string }[];
  };
}

interface GdacsResponse {
  features: GdacsFeature[];
}

function alertSeverity(alertlevel: string): number {
  if (alertlevel === "Red") return 5;
  if (alertlevel === "Orange") return 3;
  return 1;
}

export async function fetchGdacsAlerts(): Promise<DirectItem[]> {
  let res: Response;
  try {
    res = await fetch(GDACS_FEED, {
      headers: { "User-Agent": "geopulse-globe/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(`GDACS request failed: ${err}`);
  }

  if (!res.ok) {
    console.error(`GDACS fetch failed: ${res.status}`);
    return [];
  }

  const data = (await res.json()) as GdacsResponse;

  return data.features
    .map((f): DirectItem | null => {
      const p = f.properties;
      if (EXCLUDED_EVENT_TYPES.has(p.eventtype)) return null;
      if (!f.geometry || f.geometry.type !== "Point") return null;

      const [lon, lat] = f.geometry.coordinates;
      if (typeof lat !== "number" || typeof lon !== "number") return null;

      const typeLabel = EVENT_TYPE_LABELS[p.eventtype] ?? "Disaster Alert";
      const reportUrl = p.url?.report;
      if (!reportUrl) return null;

      const country = p.affectedcountries?.[0]?.iso2 ?? null;

      return {
        source: "gdacs",
        url: reportUrl,
        title: p.name,
        summary: `${typeLabel} (${p.alertlevel} alert): ${p.description || p.name}`,
        category: CLIMATE_EVENT_TYPES.has(p.eventtype)
          ? "climate-hazard"
          : "natural-disaster",
        location: p.name,
        country,
        lat,
        lon,
        severity: alertSeverity(p.alertlevel),
        publishedAt: new Date(p.fromdate),
      };
    })
    .filter((item): item is DirectItem => item !== null);
}
