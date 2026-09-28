import data from "./data/majorPorts.json";
import { haversineKm } from "./geo";
import { COUNTRY_CENTROIDS } from "./countryCentroids";

// Large and medium seaports from NGA's World Port Index, snapshotted by
// scripts/build-major-ports.ts (public domain). Loaded on demand in the
// browser (dynamic import), so it adds nothing to the initial page.
export interface MajorPort {
  name: string;
  country: string;
  size: "L" | "M";
  lat: number;
  lon: number;
  unlocode: string | null;
}

export const MAJOR_PORTS = data.ports as MajorPort[];
export const MAJOR_PORTS_SOURCE = data.source;

export const NEAR_PORT_MAX_KM = 50;

// The nearest major port within NEAR_PORT_MAX_KM of a point, or null.
// Returns null for events still sitting on their country's centroid (the
// placeholder position for news that was never geocoded): distance from
// a capital-city stand-in to a port says nothing about the event.
export function nearestMajorPort(event: {
  lat: number;
  lon: number;
  country: string | null;
}): { port: MajorPort; km: number } | null {
  const centroid = event.country ? COUNTRY_CENTROIDS[event.country] : undefined;
  if (centroid && Math.abs(centroid.lat - event.lat) < 1e-6 && Math.abs(centroid.lon - event.lon) < 1e-6) return null;
  let best: { port: MajorPort; km: number } | null = null;
  for (const port of MAJOR_PORTS) {
    const km = haversineKm(event.lat, event.lon, port.lat, port.lon);
    if (km <= NEAR_PORT_MAX_KM && (!best || km < best.km)) best = { port, km };
  }
  return best;
}
