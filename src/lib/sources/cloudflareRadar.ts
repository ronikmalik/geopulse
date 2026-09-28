// Cloudflare Radar Internet outage annotations: outages Cloudflare's team
// has confirmed and described, each with the countries affected, a cause
// (government-directed, power outage, cable cut, weather, ...) and a type
// (nationwide, regional, network). Complements IODA's automated anomaly
// detection with a named, human-reviewed cause.
// https://developers.cloudflare.com/api/resources/radar/subresources/annotations/subresources/outages/methods/get/
//
// Needs a free API token (CLOUDFLARE_API_TOKEN, Account > Radar: Read).
// LICENSE: Radar API data is CC BY-NC 4.0 (radar.cloudflare.com/about):
// non-commercial use with attribution. Same position as OONI (ooni.ts).
import { COUNTRY_CENTROIDS } from "../countryCentroids";
import type { DirectItem } from "./direct";

const ENDPOINT = "https://api.cloudflare.com/client/v4/radar/annotations/outages";

export interface RadarOutage {
  id: string;
  startDate: string;
  endDate: string | null; // null = ongoing
  countries: { code: string; name: string }[];
  cause: string | null;
  type: string | null;
  scope: string | null;
  description: string | null;
  linkedUrl: string | null;
}

interface RawAnnotation {
  id?: string | number;
  startDate?: string;
  endDate?: string | null;
  locations?: string[];
  locationsDetails?: { code?: string; name?: string }[];
  outage?: { outageCause?: string; outageType?: string };
  scope?: string | null;
  description?: string | null;
  linkedUrl?: string | null;
}

// Radar reports causes and types as enum-ish strings; show them as words.
export function humanize(value: string | undefined | null): string | null {
  if (!value) return null;
  return value
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function parseRadarOutages(body: unknown): RadarOutage[] {
  const annotations = (body as { result?: { annotations?: RawAnnotation[] } })?.result?.annotations ?? [];
  const out: RadarOutage[] = [];
  for (const a of annotations) {
    if (!a.startDate) continue;
    const details = a.locationsDetails ?? [];
    const codes = new Set((a.locations ?? []).map((c) => c.toUpperCase()));
    for (const d of details) if (d.code) codes.add(d.code.toUpperCase());
    const countries = [...codes]
      .filter((c) => /^[A-Z]{2}$/.test(c))
      .map((code) => ({ code, name: details.find((d) => d.code?.toUpperCase() === code)?.name ?? code }));
    if (countries.length === 0) continue;
    out.push({
      id: String(a.id ?? `${a.startDate}-${countries.map((c) => c.code).join("")}`),
      startDate: a.startDate,
      endDate: a.endDate ?? null,
      countries,
      cause: humanize(a.outage?.outageCause),
      type: humanize(a.outage?.outageType),
      scope: a.scope ?? null,
      description: a.description ?? null,
      linkedUrl: a.linkedUrl ?? null,
    });
  }
  return out.sort((x, y) => (x.startDate < y.startDate ? 1 : -1));
}

export class RadarNotConfiguredError extends Error {
  constructor() {
    super("Cloudflare Radar token not configured");
  }
}

export async function fetchRadarOutages(token = process.env.CLOUDFLARE_API_TOKEN): Promise<RadarOutage[]> {
  if (!token) throw new RadarNotConfiguredError();
  const params = new URLSearchParams({ dateRange: "14d", limit: "100", format: "json" });
  const res = await fetch(`${ENDPOINT}?${params}`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "geopulse-globe/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Cloudflare Radar outages: HTTP ${res.status}`);
  return parseRadarOutages(await res.json());
}

// ---------------------------------------------------------------------
// As feed events (2026-09-28). A confirmed outage is an event, so it joins
// IODA in the Infrastructure Outages category instead of sitting in a
// separate map layer: IODA detects outages automatically from probing and
// routing data; Cloudflare's are confirmed by its team from its own
// traffic, with a stated cause. Two independent instruments, so an outage
// both report counts as corroborated rather than deduplicated away. One
// event per outage and affected country, at the capital (country-level).

const OUTAGE_CENTER = "https://radar.cloudflare.com/outage-center";

export function radarOutageSeverity(type: string | null): number {
  const t = (type ?? "").toLowerCase();
  if (t.includes("nationwide")) return 4;
  if (t.includes("regional")) return 3;
  return 2;
}

function utc(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

export function radarOutagesToItems(outages: RadarOutage[]): DirectItem[] {
  const items: DirectItem[] = [];
  for (const o of outages) {
    for (const c of o.countries) {
      const at = COUNTRY_CENTROIDS[c.code];
      if (!at) continue;
      const kind = o.type ? `${o.type.toLowerCase()} ` : "";
      const cause = o.cause ? `, cause: ${o.cause.toLowerCase()}` : "";
      const span = o.endDate ? `, ${utc(o.startDate)} to ${utc(o.endDate)} UTC` : `, since ${utc(o.startDate)} UTC`;
      const lead = o.description ? `${o.description.trim().replace(/[.\s]*$/, "")}. ` : "";
      items.push({
        source: "cloudflare-radar",
        url: `${OUTAGE_CENTER}#${encodeURIComponent(o.id)}-${c.code}`,
        title: `Internet outage in ${c.name}${o.cause ? `: ${o.cause.toLowerCase()}` : ""}`,
        summary: `${lead}Cloudflare Radar confirmed a ${kind}internet outage in ${c.name}${cause}${span}.`,
        category: "infrastructure-outage",
        location: at.name,
        country: c.code,
        lat: at.lat,
        lon: at.lon,
        severity: radarOutageSeverity(o.type),
        publishedAt: new Date(o.startDate),
      });
    }
  }
  return items;
}

// Ingest runs on GitHub Actions, where the token is not set; there it
// reads the site's own cached layer route (APP_ORIGIN), which holds the
// token on Vercel. Either path yields the same outages.
export async function fetchRadarOutageItems(): Promise<DirectItem[]> {
  if (process.env.CLOUDFLARE_API_TOKEN) return radarOutagesToItems(await fetchRadarOutages());
  const origin = process.env.APP_ORIGIN;
  if (!origin) throw new RadarNotConfiguredError();
  const res = await fetch(new URL("/api/layers/internet-outages", origin), { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`internet-outages route: HTTP ${res.status}`);
  const body = (await res.json()) as { outages?: RadarOutage[]; error?: string };
  if (body.error) throw new Error(`internet-outages route: ${body.error}`);
  return radarOutagesToItems(body.outages ?? []);
}
