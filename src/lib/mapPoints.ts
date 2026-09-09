import type { TrackedAircraft } from "@/lib/sources/adsblol";
import type { WeatherSnapshot } from "@/lib/sources/openmeteo";
import type { JammedRegion } from "@/lib/sources/gpsjam";
import type { CableCountryExposure } from "@/lib/sources/submarineCables";
import type { TravelAdvisory } from "@/lib/sources/travelAdvisories";
import type { WorldBankObservation } from "@/lib/sources/worldbank";
import type { OwidEnergyCountry } from "@/lib/sources/owidEnergy";
import type { CountryTradeSummary } from "@/lib/sources/comtrade";
import type { ChokepointTransit } from "@/lib/sources/portwatch";
import type { AirQualityReading } from "@/lib/sources/openMeteoAirQuality";
import type { KevEntry } from "@/lib/sources/cisakev";
import { COUNTRY_CENTROIDS } from "@/lib/countryCentroids";
import { ALPHA2_TO_ALPHA3 } from "@/lib/iso3";

// A point rendered on the globe that isn't a geopolitical GeoEvent — the
// `kind` discriminant is how Globe.tsx tells these apart from events sharing
// the same pointsData array (globe.gl only supports one points layer, so we
// merge rather than add a second layer).
export interface ExtraMapPoint {
  kind:
    | "flight"
    | "commercial-flight"
    | "weather"
    | "gps-jamming"
    | "submarine-cable"
    | "travel-advisory"
    | "grid-loss"
    | "energy-mix"
    | "trade-balance"
    | "port-congestion"
    | "air-quality"
    | "cyber";
  id: string;
  lat: number;
  lon: number;
  color: string;
  radius: number;
  label: string;
}

// Most new context layers are per-country aggregates (a count/percentage/
// level, not a real event-level coordinate) — plotted at the country's
// capital-city centroid, the same "country code -> a point" approximation
// COUNTRY_CENTROIDS already documents itself as existing for (see that
// file's header). A country missing from that table is dropped rather than
// mis-plotted, same rule every caller below follows.
function centroidFor(iso2: string): { lat: number; lon: number } | null {
  const c = COUNTRY_CENTROIDS[iso2.toUpperCase()];
  return c ? { lat: c.lat, lon: c.lon } : null;
}

let alpha3ToAlpha2Cache: Map<string, string> | null = null;
function iso3ToIso2(iso3: string): string | null {
  if (!alpha3ToAlpha2Cache) {
    alpha3ToAlpha2Cache = new Map(
      Object.entries(ALPHA2_TO_ALPHA3).map(([a2, a3]) => [a3, a2]),
    );
  }
  return alpha3ToAlpha2Cache.get(iso3) ?? null;
}

// Linear scale clamped to a [min, max] radius band, all new layers share
// this so a busy toggle combination (several context layers at once) stays
// visually legible rather than one layer's dots dwarfing every other kind
// on the same globe.
function scaleRadius(value: number, maxValue: number, min: number, max: number): number {
  if (maxValue <= 0) return min;
  const t = Math.max(0, Math.min(1, value / maxValue));
  return min + t * (max - min);
}

const FLIGHT_COLOR = "#38bdf8"; // sky blue — visually distinct from event severity reds
const COMMERCIAL_FLIGHT_COLOR = "#a3e635"; // lime — distinct from military blue
const WEATHER_COLOR = "#facc15"; // amber

export function flightsToPoints(aircraft: TrackedAircraft[]): ExtraMapPoint[] {
  return aircraft.map((a) => ({
    kind: "flight",
    id: a.hex,
    lat: a.lat,
    lon: a.lon,
    color: FLIGHT_COLOR,
    radius: 0.22,
    label: `<b>${a.flight ?? a.registration ?? a.hex}</b><br/>${a.type ?? "Unknown type"}${
      a.altitudeFt != null ? ` · ${a.altitudeFt.toLocaleString()} ft` : ""
    }${a.groundSpeedKt != null ? ` · ${Math.round(a.groundSpeedKt)} kt` : ""}`,
  }));
}

export function commercialFlightsToPoints(
  aircraft: TrackedAircraft[],
): ExtraMapPoint[] {
  return aircraft.map((a) => ({
    kind: "commercial-flight",
    id: a.hex,
    lat: a.lat,
    lon: a.lon,
    color: COMMERCIAL_FLIGHT_COLOR,
    radius: 0.16,
    label: `<b>${a.flight ?? a.hex}</b><br/>${a.category ?? "Unknown origin"}${
      a.altitudeFt != null ? ` · ${a.altitudeFt.toLocaleString()} ft` : ""
    }${a.groundSpeedKt != null ? ` · ${Math.round(a.groundSpeedKt)} kt` : ""}`,
  }));
}

export function weatherToPoints(conditions: WeatherSnapshot[]): ExtraMapPoint[] {
  return conditions.map((c) => ({
    kind: "weather",
    id: c.location.name,
    lat: c.location.lat,
    lon: c.location.lon,
    color: WEATHER_COLOR,
    radius: 0.3,
    label: `<b>${c.location.name}</b><br/>${c.temperatureC.toFixed(1)}°C · wind ${Math.round(
      c.windSpeedKmh,
    )} km/h${c.precipitationMm > 0 ? ` · ${c.precipitationMm.toFixed(1)}mm precip` : ""}`,
  }));
}

const GPS_JAMMING_COLOR = "#f97316"; // orange — distinct danger/interference cue
const SUBMARINE_CABLE_COLOR = "#22d3ee"; // cyan — infrastructure/network theme
const GRID_LOSS_COLOR = "#fb923c"; // orange, lighter than jamming
const ENERGY_MIX_COLOR = "#eab308"; // yellow
const TRADE_BALANCE_COLOR = "#a78bfa"; // violet — economic theme
const PORT_CONGESTION_COLOR = "#2dd4bf"; // teal — maritime theme

export function gpsJammingToPoints(regions: JammedRegion[]): ExtraMapPoint[] {
  const maxCount = Math.max(...regions.map((r) => r.badAircraftCount), 1);
  return regions
    .map((r): ExtraMapPoint | null => {
      const c = centroidFor(r.countryIso2);
      if (!c) return null;
      return {
        kind: "gps-jamming",
        id: `jam-${r.countryIso2}`,
        lat: c.lat,
        lon: c.lon,
        color: GPS_JAMMING_COLOR,
        radius: scaleRadius(r.badAircraftCount, maxCount, 0.18, 0.5),
        label: `<b>${r.countryName}</b><br/>GPS/GNSS jamming — ${r.badAircraftCount} aircraft reports (${r.badCellCount} cells)`,
      };
    })
    .filter((p): p is ExtraMapPoint => p !== null);
}

export function submarineCablesToPoints(countries: CableCountryExposure[]): ExtraMapPoint[] {
  const maxCount = Math.max(...countries.map((c) => c.landingPointCount), 1);
  return countries
    .map((country): ExtraMapPoint | null => {
      const c = centroidFor(country.countryIso2);
      if (!c) return null;
      return {
        kind: "submarine-cable",
        id: `cable-${country.countryIso2}`,
        lat: c.lat,
        lon: c.lon,
        color: SUBMARINE_CABLE_COLOR,
        radius: scaleRadius(country.landingPointCount, maxCount, 0.18, 0.45),
        label: `<b>${country.countryName}</b><br/>${country.landingPointCount} submarine cable landing points`,
      };
    })
    .filter((p): p is ExtraMapPoint => p !== null);
}

function travelAdvisoryColor(level: number): string {
  if (level >= 4) return "#ef4444"; // red — Do Not Travel
  return "#f59e0b"; // amber — Reconsider Travel (this layer only plots level 3-4, see travelAdvisories.ts's fetchElevatedAdvisories)
}

export function travelAdvisoriesToPoints(advisories: TravelAdvisory[]): ExtraMapPoint[] {
  return advisories
    .map((a): ExtraMapPoint | null => {
      const c = centroidFor(a.country);
      if (!c) return null;
      return {
        kind: "travel-advisory",
        id: `advisory-${a.country}`,
        lat: c.lat,
        lon: c.lon,
        color: travelAdvisoryColor(a.level),
        radius: a.level >= 4 ? 0.32 : 0.24,
        label: `<b>${a.countryName}</b><br/>US Travel Advisory Level ${a.level}: ${a.levelLabel}`,
      };
    })
    .filter((p): p is ExtraMapPoint => p !== null);
}

export function gridLossToPoints(countries: WorldBankObservation[]): ExtraMapPoint[] {
  const maxValue = Math.max(...countries.map((c) => c.value ?? 0), 1);
  return countries
    .map((country): ExtraMapPoint | null => {
      const iso2 = iso3ToIso2(country.countryIso3);
      const c = iso2 ? centroidFor(iso2) : null;
      if (!c || country.value == null) return null;
      return {
        kind: "grid-loss",
        id: `grid-loss-${country.countryIso3}`,
        lat: c.lat,
        lon: c.lon,
        color: GRID_LOSS_COLOR,
        radius: scaleRadius(country.value, maxValue, 0.18, 0.45),
        label: `<b>${country.countryName}</b><br/>Power grid loss: ${country.value.toFixed(1)}% of output (${country.year})`,
      };
    })
    .filter((p): p is ExtraMapPoint => p !== null);
}

export function energyMixToPoints(countries: OwidEnergyCountry[]): ExtraMapPoint[] {
  const maxValue = Math.max(...countries.map((c) => c.value), 1);
  return countries
    .map((country): ExtraMapPoint | null => {
      const iso2 = iso3ToIso2(country.countryIso3);
      const c = iso2 ? centroidFor(iso2) : null;
      if (!c) return null;
      return {
        kind: "energy-mix",
        id: `energy-mix-${country.countryIso3}`,
        lat: c.lat,
        lon: c.lon,
        color: ENERGY_MIX_COLOR,
        radius: scaleRadius(country.value, maxValue, 0.18, 0.45),
        label: `<b>${country.countryName}</b><br/>${country.value.toFixed(0)}% fossil-fuel electricity (${country.year})`,
      };
    })
    .filter((p): p is ExtraMapPoint => p !== null);
}

export function tradeBalanceToPoints(countries: CountryTradeSummary[]): ExtraMapPoint[] {
  return countries
    .map((country): ExtraMapPoint | null => {
      const c = centroidFor(country.reporterIso2);
      if (!c) return null;
      const topPartner = country.topPartners[0];
      return {
        kind: "trade-balance",
        id: `trade-${country.reporterIso2}`,
        lat: c.lat,
        lon: c.lon,
        color: TRADE_BALANCE_COLOR,
        radius: 0.28,
        label: `<b>${country.reporterName}</b><br/>Top export partner (${country.period}): ${
          topPartner ? `${topPartner.partnerName} ($${(topPartner.exportValueUsd / 1e9).toFixed(1)}B)` : "no data"
        }`,
      };
    })
    .filter((p): p is ExtraMapPoint => p !== null);
}

export function portCongestionToPoints(chokepoints: ChokepointTransit[]): ExtraMapPoint[] {
  const maxVessels = Math.max(...chokepoints.map((c) => c.totalVessels), 1);
  return chokepoints.map((c) => ({
    kind: "port-congestion",
    id: `chokepoint-${c.name}`,
    lat: c.lat,
    lon: c.lon,
    color: PORT_CONGESTION_COLOR,
    radius: scaleRadius(c.totalVessels, maxVessels, 0.18, 0.5),
    label: `<b>${c.name}</b><br/>${c.totalVessels} vessel transits (${c.date}) — ${c.cargoVessels} cargo, ${c.tankerVessels} tanker`,
  }));
}

// Loose visual-severity banding for the map dot color only — not an
// official AQI (openaq.ts deliberately shows raw µg/m³, not a converted
// index, since breakpoints differ by country; see that file's header). The
// label below always shows the real number, so the color is a glance-level
// cue on top of an honest value, not a replacement for it.
function pm25Color(pm25: number): string {
  if (pm25 > 55) return "#ef4444";
  if (pm25 > 35) return "#f97316";
  if (pm25 > 15) return "#facc15";
  return "#4ade80";
}

export function airQualityToPoints(readings: AirQualityReading[]): ExtraMapPoint[] {
  return readings
    .filter((r) => r.pm25 != null)
    .map((r) => ({
      kind: "air-quality" as const,
      id: `aq-${r.location.name}`,
      lat: r.location.lat,
      lon: r.location.lon,
      color: pm25Color(r.pm25!),
      radius: 0.24,
      label: `<b>${r.location.name}</b><br/>PM2.5: ${r.pm25} ${r.unit}${r.stationName ? ` (${r.stationName})` : ""}`,
    }));
}

const CYBER_COLOR = "#ec4899"; // magenta — visually distinct from every other layer's color

// CISA KEV entries have no native geolocation (cisakev.ts's own header
// comment: "a global feed (vendor/product, not a country)") — a vulnerable
// product doesn't tell you where it's being exploited. The best available
// proxy is where the vendor is headquartered, so this app plots on that
// basis (same "known compromise, not perfect precision" spirit as every
// other proxy-based layer here). Ordered, case-insensitive substring match
// against the raw vendorProject string — first match wins; an unmatched
// vendor is dropped rather than mis-plotted, same rule every other
// function in this file follows.
const VENDOR_COUNTRY: [string, string][] = [
  ["microsoft", "US"], ["apple", "US"], ["google", "US"], ["cisco", "US"],
  ["oracle", "US"], ["adobe", "US"], ["vmware", "US"], ["broadcom", "US"],
  ["ivanti", "US"], ["juniper", "US"], ["f5", "US"], ["citrix", "US"],
  ["palo alto", "US"], ["solarwinds", "US"], ["kaseya", "US"],
  ["progress software", "US"], ["moveit", "US"], ["fortra", "US"],
  ["dell", "US"], ["hp inc", "US"], ["hewlett", "US"], ["ibm", "US"],
  ["red hat", "US"], ["gitlab", "US"], ["atlassian", "AU"],
  ["apache software foundation", "US"], ["wordpress", "US"],
  ["automattic", "US"], ["php group", "US"], ["mozilla", "US"],
  ["n-able", "US"], ["qualcomm", "US"], ["cloudflare", "US"],
  ["zoom", "US"], ["linux", "US"],
  ["sap", "DE"], ["siemens", "DE"], ["ashlar", "DE"],
  ["fortinet", "US"], ["sonicwall", "US"], ["watchguard", "US"],
  ["zoho", "IN"],
  ["samsung", "KR"],
  ["huawei", "CN"], ["zte", "CN"], ["tp-link", "CN"], ["xiaomi", "CN"],
  ["d-link", "TW"], ["zyxel", "TW"], ["qnap", "TW"], ["draytek", "TW"],
  ["asus", "TW"], ["realtek", "TW"], ["synology", "TW"],
  ["trend micro", "JP"], ["mitsubishi electric", "JP"],
  ["sophos", "GB"],
  ["schneider electric", "FR"],
  ["netgear", "US"],
  ["drupal", "BE"],
  ["honeywell", "US"],
  ["sangoma", "CA"],
];

function attributeVendorCountry(vendorProject: string): string | null {
  const v = vendorProject.toLowerCase();
  for (const [needle, iso2] of VENDOR_COUNTRY) {
    if (v.includes(needle)) return iso2;
  }
  return null;
}

export function cisaKevToPoints(vulnerabilities: KevEntry[]): ExtraMapPoint[] {
  const byCountry = new Map<
    string,
    { count: number; ransomwareCount: number; vendors: Set<string> }
  >();
  for (const kev of vulnerabilities) {
    const iso2 = attributeVendorCountry(kev.vendorProject);
    if (!iso2) continue;
    const existing = byCountry.get(iso2);
    if (existing) {
      existing.count++;
      if (kev.knownRansomwareUse) existing.ransomwareCount++;
      existing.vendors.add(kev.vendorProject);
    } else {
      byCountry.set(iso2, {
        count: 1,
        ransomwareCount: kev.knownRansomwareUse ? 1 : 0,
        vendors: new Set([kev.vendorProject]),
      });
    }
  }

  const maxCount = Math.max(...[...byCountry.values()].map((v) => v.count), 1);
  return [...byCountry.entries()]
    .map(([iso2, agg]): ExtraMapPoint | null => {
      const c = centroidFor(iso2);
      if (!c) return null;
      const vendorList = [...agg.vendors].slice(0, 5).join(", ");
      return {
        kind: "cyber",
        id: `cyber-${iso2}`,
        lat: c.lat,
        lon: c.lon,
        color: CYBER_COLOR,
        radius: scaleRadius(agg.count, maxCount, 0.18, 0.45),
        label: `<b>${COUNTRY_CENTROIDS[iso2]?.name ?? iso2}-based vendors</b><br/>${agg.count} actively exploited vulnerabilities (CISA KEV)${
          agg.ransomwareCount > 0 ? `, ${agg.ransomwareCount} tied to ransomware` : ""
        }<br/>${vendorList}`,
      };
    })
    .filter((p): p is ExtraMapPoint => p !== null);
}
