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

interface Cell {
  gi: number; // grid index (lat / GRID_SIZE, rounded) — integer, not the
  gj: number; // floating-point value, so adjacency comparison is exact
  count: number;
  totalFrp: number;
  sumLat: number;
  sumLon: number;
  latestDate: string;
  latestTime: string;
}

interface Cluster {
  anchorGi: number;
  anchorGj: number;
  count: number;
  totalFrp: number;
  sumLat: number;
  sumLon: number;
  latestDate: string;
  latestTime: string;
}

// 2026-09-04 fix: this used to key clusters by raw 0.25° grid cell with no
// merging step, which meant one real contiguous fire region spanning
// several adjacent cells (routine during Southern Africa's dry-season
// agricultural burning, observed live: Angola/Namibia each producing a
// dozen+ separate same-day "cluster" events from what was clearly one
// burn region) got scored as that many independent hazard events — each
// adding its own severity into the same pillar's decayed-weight sum,
// pushing countries to "Extreme" off routine, unremarkable burning rather
// than anything resembling a real hazard spike. Cells are now merged by
// 8-connected adjacency (flood fill) into one cluster per contiguous
// region before the reportability threshold is applied, so a wide burn
// scar is one event, not ten.
function clusterDetections(detections: FirmsDetection[]): Cluster[] {
  const cells = new Map<string, Cell>();
  for (const d of detections) {
    const gi = Math.round(d.lat / GRID_SIZE);
    const gj = Math.round(d.lon / GRID_SIZE);
    const key = `${gi},${gj}`;
    const existing = cells.get(key);
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
      cells.set(key, {
        gi,
        gj,
        count: 1,
        totalFrp: d.frp,
        sumLat: d.lat,
        sumLon: d.lon,
        latestDate: d.acqDate,
        latestTime: d.acqTime,
      });
    }
  }

  // Flood-fill 8-connected adjacent cells into one component each.
  const visited = new Set<string>();
  const clusters: Cluster[] = [];
  for (const [key, start] of cells) {
    if (visited.has(key)) continue;
    const stack = [start];
    visited.add(key);
    const component: Cell[] = [];
    while (stack.length > 0) {
      const cell = stack.pop()!;
      component.push(cell);
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          if (di === 0 && dj === 0) continue;
          const nKey = `${cell.gi + di},${cell.gj + dj}`;
          const neighbor = cells.get(nKey);
          if (neighbor && !visited.has(nKey)) {
            visited.add(nKey);
            stack.push(neighbor);
          }
        }
      }
    }

    // Anchor on the lexicographically smallest cell in the component so the
    // dedup URL (below) stays stable across ingest cycles even as the fire's
    // edges grow/shrink — the same stability requirement already documented
    // for the per-cell dedup key this replaces.
    const anchor = component.reduce((a, b) =>
      a.gi < b.gi || (a.gi === b.gi && a.gj < b.gj) ? a : b,
    );
    const latest = component.reduce((a, c) =>
      c.latestDate > a.latestDate || (c.latestDate === a.latestDate && c.latestTime > a.latestTime) ? c : a,
    );

    clusters.push({
      anchorGi: anchor.gi,
      anchorGj: anchor.gj,
      count: component.reduce((s, c) => s + c.count, 0),
      totalFrp: component.reduce((s, c) => s + c.totalFrp, 0),
      sumLat: component.reduce((s, c) => s + c.sumLat, 0),
      sumLon: component.reduce((s, c) => s + c.sumLon, 0),
      latestDate: latest.latestDate,
      latestTime: latest.latestTime,
    });
  }

  return clusters.filter(
    (c) => c.count >= MIN_CLUSTER_DETECTIONS && c.totalFrp >= MIN_CLUSTER_FRP,
  );
}

// Capped at 3 (Medium/High-pillar territory), never 4-5: FIRMS can't
// confirm cause (a large agricultural burn and something far more serious
// produce an identical signal — see the header comment), so it can raise a
// pillar toward High as real corroborating signal but must never alone
// declare a country "Extreme" the way a confirmed source (GDACS Red alert,
// a real large earthquake) can. See docs/OSINT_SOURCES.md.
function clusterSeverity(c: Cluster): number {
  if (c.count >= 40) return 3;
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
  // the repeat. The URL below must use the cluster's anchor grid cell, NOT
  // the floating sumLat/count average — the average shifts as individual
  // detections enter/leave the rolling 24h window between cycles, which was
  // silently defeating the dedup and re-inserting the same ongoing fire as
  // a "new" event every cycle (exactly the bug the IODA comment describes
  // already having happened there once).
  const dayBucket = new Date().toISOString().slice(0, 10);

  return clusters
    .map((c): DirectItem | null => {
      const lat = c.sumLat / c.count;
      const lon = c.sumLon / c.count;
      const country = countryFromLatLon(lat, lon);
      if (!country) return null;

      const anchorLat = c.anchorGi * GRID_SIZE;
      const anchorLon = c.anchorGj * GRID_SIZE;

      return {
        source: "firms",
        url: `https://firms.modaps.eosdis.nasa.gov/map/#d:${dayBucket};l:viirs-snpp;@${anchorLon.toFixed(2)},${anchorLat.toFixed(2)},7z`,
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
