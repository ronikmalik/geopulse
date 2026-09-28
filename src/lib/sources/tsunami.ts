import { haversineKm } from "../geo";

// NOAA's two tsunami warning centers publish their latest bulletin as an
// Atom feed (verified live 2026-09-28): the National Tsunami Warning
// Center (Palmer, AK) and the Pacific Tsunami Warning Center (Honolulu).
// US government work, public domain. https://www.tsunami.gov/
//
// Each feed carries only the most recent bulletin, with its category
// (Information, Advisory, Watch, Warning, Threat, Cancellation), the
// preliminary epicentre and magnitude, and sometimes a note such as
// "There is NO tsunami danger from this earthquake." GeoPulse attaches
// that official status to the matching USGS earthquake, quoting NOAA,
// because USGS's own `tsunami` flag says nothing about whether a tsunami
// happened (see usgs.ts).
export const TSUNAMI_FEEDS = [
  { center: "NTWC", url: "https://www.tsunami.gov/events/xml/PAAQAtom.xml" },
  { center: "PTWC", url: "https://www.tsunami.gov/events/xml/PHEBAtom.xml" },
] as const;

export type TsunamiCenter = (typeof TSUNAMI_FEEDS)[number]["center"];

export interface TsunamiBulletin {
  center: TsunamiCenter;
  category: string; // as NOAA writes it, e.g. "Information", "Warning"
  issuedAt: Date;
  lat: number;
  lon: number;
  magnitude: number | null;
  region: string;
  note: string | null;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// "<strong>Category:</strong> Information<br/>" -> "Information"
function field(summary: string, label: string): string | null {
  const re = new RegExp(`<(?:strong|b)>\\s*${label}:?\\s*</(?:strong|b)>([\\s\\S]*?)<br\\s*/?>`, "i");
  const m = re.exec(summary);
  if (!m) return null;
  const value = stripTags(m[1]);
  return value.length > 0 ? value : null;
}

export function parseTsunamiAtom(xml: string, center: TsunamiCenter): TsunamiBulletin[] {
  const out: TsunamiBulletin[] = [];
  for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const lat = Number(/<geo:lat>\s*([-\d.]+)\s*<\/geo:lat>/.exec(entry)?.[1]);
    const lon = Number(/<geo:long>\s*([-\d.]+)\s*<\/geo:long>/.exec(entry)?.[1]);
    const summary = /<summary[^>]*>([\s\S]*?)<\/summary>/.exec(entry)?.[1] ?? "";
    const category = field(summary, "Category");
    const issued = field(summary, "Bulletin Issue Time");
    // "2026.09.27 21:56:18 UTC" -> ISO
    const issuedIso = issued?.replace(/^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/, "$1-$2-$3T$4Z");
    const updated = /<updated>([^<]+)<\/updated>/.exec(entry)?.[1];
    const issuedAt = new Date(issuedIso && issuedIso !== issued ? issuedIso : updated ?? NaN);
    if (!category || !Number.isFinite(lat) || !Number.isFinite(lon) || Number.isNaN(issuedAt.getTime())) continue;
    const magnitude = Number.parseFloat(field(summary, "Preliminary Magnitude") ?? "");
    const title = stripTags(/<title>([\s\S]*?)<\/title>/.exec(entry)?.[1] ?? "");
    out.push({
      center,
      category,
      issuedAt,
      lat,
      lon,
      magnitude: Number.isFinite(magnitude) ? magnitude : null,
      region: field(summary, "Affected Region") ?? title,
      note: field(summary, "Note"),
    });
  }
  return out;
}

export async function fetchTsunamiBulletins(): Promise<TsunamiBulletin[]> {
  const results = await Promise.all(
    TSUNAMI_FEEDS.map(async ({ center, url }) => {
      const res = await fetch(url, {
        headers: { "User-Agent": "geopulse-globe/1.0" },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) throw new Error(`tsunami.gov ${center} feed: HTTP ${res.status}`);
      return parseTsunamiAtom(await res.text(), center);
    }),
  );
  return results.flat();
}

// The text GeoPulse appends to the quake's summary. NOAA's own words: the
// category it issued and, when present, its note, quoted verbatim.
export function tsunamiStatusText(b: TsunamiBulletin): string {
  const base = `Tsunami status (NOAA ${b.center}): ${b.category.toLowerCase()} bulletin`;
  const quoted = b.note?.replace(/^\*\s*/, "").replace(/"/g, "'").trim();
  if (!quoted) return `${base}.`;
  return `${base} - "${quoted}${/[.!?]$/.test(quoted) ? "" : "."}"`;
}

// Everything from the status marker to the end is GeoPulse's appended
// text, so a newer bulletin replaces the older one instead of stacking.
const STATUS_MARKER = / Tsunami status \(NOAA [A-Z]+\):[\s\S]*$/;

export function withTsunamiStatus(summary: string, b: TsunamiBulletin): string {
  return `${summary.replace(STATUS_MARKER, "")} ${tsunamiStatusText(b)}`;
}

export interface QuakeCandidate {
  id: number;
  lat: number;
  lon: number;
  publishedAt: Date;
}

// A bulletin follows its earthquake by minutes (typically 5-20), and its
// preliminary epicentre can sit tens of km from USGS's. Match the nearest
// quake that happened within this window before the bulletin and within
// this distance of it; no match means the quake is not in GeoPulse (below
// the M4.5 floor, or outside the feed's window) and nothing is changed.
export const MATCH_WINDOW_BEFORE_MS = 3 * 60 * 60_000;
export const MATCH_WINDOW_AFTER_MS = 10 * 60_000;
export const MATCH_MAX_KM = 250;

export function matchBulletinToQuake(b: TsunamiBulletin, quakes: QuakeCandidate[]): number | null {
  let best: { id: number; km: number } | null = null;
  const issued = b.issuedAt.getTime();
  for (const q of quakes) {
    const t = q.publishedAt.getTime();
    if (t < issued - MATCH_WINDOW_BEFORE_MS || t > issued + MATCH_WINDOW_AFTER_MS) continue;
    const km = haversineKm(b.lat, b.lon, q.lat, q.lon);
    if (km <= MATCH_MAX_KM && (!best || km < best.km)) best = { id: q.id, km };
  }
  return best?.id ?? null;
}
