import { resolveCountryFromText } from "@/lib/countryNames";
import type { Category } from "@/lib/categories";
import type { DirectItem } from "./direct";

// NASA EONET v3 — open natural-hazard events, no API key required.
// https://eonet.gsfc.nasa.gov/docs/v3
const EONET_FEED =
  "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=3&limit=100";

interface EonetGeometry {
  date: string;
  type: string;
  coordinates: unknown;
}

interface EonetEvent {
  id: string;
  title: string;
  link: string;
  categories: { id: string; title: string }[];
  geometry: EonetGeometry[];
}

interface EonetResponse {
  events: EonetEvent[];
}

function categorySeverity(categoryTitle: string): number {
  if (/volcano/i.test(categoryTitle)) return 3;
  if (/severe storms/i.test(categoryTitle)) return 3;
  if (/wildfires/i.test(categoryTitle)) return 2;
  if (/floods/i.test(categoryTitle)) return 2;
  return 1;
}

// Wildfires/floods/drought -> Climate & Environment pillar; volcanoes and
// severe storms -> Natural & Biological Hazards pillar. See gdacs.ts for
// the same split and src/lib/pillars.ts for the pillar definitions.
function categoryBucket(categoryTitle: string): Category {
  if (/wildfires|floods|drought/i.test(categoryTitle)) return "climate-hazard";
  return "natural-disaster";
}

export async function fetchNasaEonet(): Promise<DirectItem[]> {
  let res: Response;
  try {
    res = await fetch(EONET_FEED, {
      headers: { "User-Agent": "geopulse-globe/1.0" },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (err) {
    throw new Error(`NASA EONET request failed: ${err}`);
  }

  if (!res.ok) {
    console.error(`NASA EONET fetch failed: ${res.status}`);
    return [];
  }

  const data = (await res.json()) as EonetResponse;

  return data.events
    .map((ev): DirectItem | null => {
      const geom = ev.geometry[ev.geometry.length - 1];
      if (!geom || geom.type !== "Point" || !Array.isArray(geom.coordinates)) {
        return null;
      }
      const [lon, lat] = geom.coordinates as [number, number];
      if (typeof lat !== "number" || typeof lon !== "number") return null;

      const categoryTitle = ev.categories[0]?.title ?? "Natural Event";
      return {
        source: "eonet",
        url: ev.link || `https://eonet.gsfc.nasa.gov/api/v3/events/${ev.id}`,
        title: ev.title,
        summary: `${categoryTitle}: ${ev.title}`,
        category: categoryBucket(categoryTitle),
        location: ev.title,
        country: resolveCountryFromText(ev.title),
        lat,
        lon,
        severity: categorySeverity(categoryTitle),
        publishedAt: new Date(geom.date),
      };
    })
    .filter((item): item is DirectItem => item !== null);
}
