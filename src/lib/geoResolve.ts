import * as topojson from "topojson-client";
import countries110m from "world-atlas/countries-110m.json";
import type { Topology, GeometryCollection } from "topojson-specification";
import { ISO_NUMERIC_TO_ALPHA2 } from "@/lib/isoCountries";

// Reverse-geocodes a bare lat/lon into an ISO alpha-2 country code with no
// external API call — needed for sources like FIRMS that report a raw
// coordinate with no place name or country field at all (unlike USGS,
// which gives a "place" string resolveCountryFromText can parse, or GDACS,
// which lists affected countries directly). Reuses the same world-atlas
// 110m country boundaries + topojson-client already shipped for the globe's
// visual borders (src/components/Globe.tsx) — no new dependency, and same
// coarse (1:110,000,000) precision, which is acceptable here: this is used
// to attribute a detection to *a* country, not to place it on a map.
const countryFeatures = topojson.feature(
  countries110m as unknown as Topology,
  (countries110m as unknown as Topology).objects.countries as GeometryCollection,
).features;

type Ring = [number, number][];

function pointInRing([x, y]: [number, number], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// Even-odd rule across every ring (outer boundary + holes) of one polygon —
// XORing hole rings back out is exactly what makes a point inside a hole
// correctly read as "outside" the polygon.
function pointInPolygonRings(pt: [number, number], rings: Ring[]): boolean {
  return rings.reduce((inside, ring) => inside !== pointInRing(pt, ring), false);
}

interface CountryFeature {
  id?: string;
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: Ring[] | Ring[][];
  };
}

export function countryFromLatLon(lat: number, lon: number): string | null {
  const pt: [number, number] = [lon, lat];
  for (const feature of countryFeatures as unknown as CountryFeature[]) {
    const { geometry, id } = feature;
    if (!geometry || !id) continue;
    const alpha2 = ISO_NUMERIC_TO_ALPHA2[id];
    if (!alpha2) continue;

    if (geometry.type === "Polygon") {
      if (pointInPolygonRings(pt, geometry.coordinates as Ring[])) return alpha2;
    } else {
      for (const polygon of geometry.coordinates as Ring[][]) {
        if (pointInPolygonRings(pt, polygon)) return alpha2;
      }
    }
  }
  return null;
}
