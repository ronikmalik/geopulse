import { countryFromLatLon } from "@/lib/geoResolve";
import type { DirectItem } from "./direct";

// NASA FIRMS (Fire Information for Resource Management System) — VIIRS
// satellite thermal-anomaly detections, ~3h latency from overpass to API
// availability (NASA's own stated NRT latency). This is the closest thing
// in this app's source list to genuine "just happened" ground-truth signal
// rather than a written-and-published news article: it's a direct physical
// sensor reading, not a report about one.
//
// Requires a free MAP_KEY (email signup, no review/approval wait) —
// https://firms.modaps.eosdis.nasa.gov/api/map_key/ — set as FIRMS_MAP_KEY.
// Public domain / free for commercial use per general NASA open-data
// policy; no FIRMS-specific terms page was found confirming this in so
// many words, so treat that as inferred, not contractually confirmed, if
// this ever matters for something with real commercial stakes.
// Docs: https://firms.modaps.eosdis.nasa.gov/api/area/
//
// IMPORTANT — what this signal can and can't tell you: FIRMS detects a
// thermal anomaly, full stop. It has no way to distinguish a wildfire, an
// industrial fire, agricultural burning, a gas flare, or an explosion/
// strike from each other — the NRT product's own "type" column isn't
// populated. Framed here as "thermal anomaly", never as a confirmed cause,
// and country attribution (via src/lib/geoResolve.ts) already discards
// anything that doesn't land inside a country polygon, which incidentally
// filters out most offshore gas-flare false positives for free.
const FIRMS_ENDPOINT = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";
const SOURCE_PRODUCT = "VIIRS_SNPP_NRT";
const DAY_RANGE = 1;

interface FirmsDetection {
  lat: number;
  lon: number;
  frp: number;
  confidence: string;
  acqDate: string;
  acqTime: string;
}

function isHighConfidence(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === "h" || v === "high") return true;
  const n = Number(v);
  return !Number.isNaN(n) && n >= 80; // MODIS-style numeric confidence, defensive fallback
}

function parseCsv(text: string): FirmsDetection[] {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const iLat = idx("latitude");
  const iLon = idx("longitude");
  const iFrp = idx("frp");
  const iConf = idx("confidence");
  const iDate = idx("acq_date");
  const iTime = idx("acq_time");
  if (iLat < 0 || iLon < 0 || iConf < 0) return [];

  const out: FirmsDetection[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < header.length) continue;
    const lat = Number(cols[iLat]);
    const lon = Number(cols[iLon]);
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
    out.push({
      lat,
      lon,
      frp: iFrp >= 0 ? Number(cols[iFrp]) || 0 : 0,
      confidence: cols[iConf] ?? "",
      acqDate: iDate >= 0 ? cols[iDate] : "",
      acqTime: iTime >= 0 ? cols[iTime] : "",
    });
  }
  return out;
}

// Coarse grid clustering (~0.25 degrees, ~28km at the equator) — groups
// individual hotspot pixels into candidate "one large event" clusters, the
// same spirit as IODA's event_cnt threshold (src/lib/sources/ioda.ts):
// filter background noise, surface only what's big enough to matter.
const GRID_SIZE = 0.25;
// Conservative starting thresholds — VIIRS detects thousands of small
// agricultural/routine burns globally every day, and this app has no
// history yet to tune against. Both numbers are a first guess to revisit
// once real ingest data shows what "big" actually looks like in practice.
const MIN_CLUSTER_DETECTIONS = 8;
const MIN_CLUSTER_FRP = 500; // megawatts, summed across the cluster

interface Cluster {
  key: string;
  gLat: number;
  gLon: number;
  count: number;
  totalFrp: number;
  sumLat: number;
  sumLon: number;
  latestDate: string;
  latestTime: string;
}

function clusterDetections(detections: FirmsDetection[]): Cluster[] {
  const clusters = new Map<string, Cluster>();
  for (const d of detections) {
    const gLat = Math.round(d.lat / GRID_SIZE) * GRID_SIZE;
    const gLon = Math.round(d.lon / GRID_SIZE) * GRID_SIZE;
    const key = `${gLat.toFixed(2)},${gLon.toFixed(2)}`;
    const existing = clusters.get(key);
    if (existing) {
      existing.count += 1;
      existing.totalFrp += d.frp;
      existing.sumLat += d.lat;
      existing.sumLon += d.lon;
      if (d.acqDate > existing.latestDate || (d.acqDate === existing.latestDate && d.acqTime > existing.latestTime)) {
        existing.latestDate = d.acqDate;
        existing.latestTime = d.acqTime;
      }
    } else {
      clusters.set(key, {
        key,
        gLat,
        gLon,
        count: 1,
        totalFrp: d.frp,
        sumLat: d.lat,
        sumLon: d.lon,
        latestDate: d.acqDate,
        latestTime: d.acqTime,
      });
    }
  }
  return [...clusters.values()].filter(
    (c) => c.count >= MIN_CLUSTER_DETECTIONS && c.totalFrp >= MIN_CLUSTER_FRP,
  );
}

function clusterSeverity(c: Cluster): number {
  if (c.count >= 60) return 5;
  if (c.count >= 30) return 4;
  if (c.count >= 15) return 3;
  return 2;
}

function parseAcqDateTime(date: string, time: string): Date {
  // acq_time is HHMM (UTC), no colon.
  const t = time.padStart(4, "0");
  const iso = `${date}T${t.slice(0, 2)}:${t.slice(2, 4)}:00Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export async function fetchFirmsThermalAnomalies(): Promise<DirectItem[]> {
  const mapKey = process.env.FIRMS_MAP_KEY;
  if (!mapKey) {
    // No key configured — treat as a soft no-op rather than a hard error,
    // same as any other optional-credential source, so ingest doesn't fail
    // globally just because this one source isn't set up yet.
    return [];
  }

  const url = `${FIRMS_ENDPOINT}/${mapKey}/${SOURCE_PRODUCT}/world/${DAY_RANGE}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "geopulse-globe/1.0" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new Error(`FIRMS request failed: ${err}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`FIRMS fetch failed: ${res.status} ${body.slice(0, 200)}`);
  }

  const text = await res.text();
  const detections = parseCsv(text).filter((d) => isHighConfidence(d.confidence));
  const clusters = clusterDetections(detections);

  // Same day-bucket dedup-URL strategy as IODA (see the comment there): this
  // is a rolling 24h summary re-fetched every ingest cycle, not a discrete
  // new event each time, so the dedup key must be stable within a day or
  // onConflictDoNothing (events.url, see ingest.ts) never actually catches
  // the repeat. The URL below must use the cluster's fixed grid cell
  // (c.gLat/c.gLon), NOT the floating sumLat/count average below — the
  // average shifts as individual detections enter/leave the rolling 24h
  // window between cycles, which was silently defeating the dedup and
  // re-inserting the same ongoing fire as a "new" event every cycle
  // (exactly the bug the IODA comment describes already having happened
  // there once).
  const dayBucket = new Date().toISOString().slice(0, 10);

  return clusters
    .map((c): DirectItem | null => {
      const lat = c.sumLat / c.count;
      const lon = c.sumLon / c.count;
      const country = countryFromLatLon(lat, lon);
      if (!country) return null;

      return {
        source: "firms",
        url: `https://firms.modaps.eosdis.nasa.gov/map/#d:${dayBucket};l:viirs-snpp;@${c.gLon.toFixed(2)},${c.gLat.toFixed(2)},7z`,
        title: `Large thermal anomaly cluster detected (satellite) near ${lat.toFixed(2)}, ${lon.toFixed(2)}`,
        summary: `NASA FIRMS/VIIRS detected ${c.count} high-confidence thermal anomalies (combined ${Math.round(c.totalFrp)} MW radiative power) clustered in one area within the last 24h. Satellite thermal data alone cannot confirm cause — wildfire, industrial fire, and explosive/conflict-related fire all look the same to this sensor.`,
        category: "natural-disaster",
        location: `${lat.toFixed(2)}, ${lon.toFixed(2)}`,
        country,
        lat,
        lon,
        severity: clusterSeverity(c),
        publishedAt: parseAcqDateTime(c.latestDate, c.latestTime),
      };
    })
    .filter((item): item is DirectItem => item !== null);
}
