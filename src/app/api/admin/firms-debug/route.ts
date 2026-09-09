import { NextRequest, NextResponse } from "next/server";

// TEMPORARY diagnostic route — investigating why fetchFirmsThermalAnomalies
// has returned 0 items for several days despite a healthy source_health
// row. Unauthenticated like /api/admin/health (read-only aggregate counts,
// never the raw key or URL). ?area=/?product=/?dayRange= let us isolate a
// bad area keyword or dead product ID from a genuinely empty feed, and the
// clustering below mirrors firms.ts's real thresholds so we know whether
// switching products alone is enough or the thresholds need retuning too.
// Delete once diagnosed.
const FIRMS_ENDPOINT = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";
const GRID_SIZE = 0.25;

export async function GET(req: NextRequest) {
  const mapKey = process.env.FIRMS_MAP_KEY;
  if (!mapKey) return NextResponse.json({ error: "no key configured" });

  const area = req.nextUrl.searchParams.get("area") ?? "world";
  const product = req.nextUrl.searchParams.get("product") ?? "VIIRS_SNPP_NRT";
  const dayRange = req.nextUrl.searchParams.get("dayRange") ?? "1";
  const url = `${FIRMS_ENDPOINT}/${mapKey}/${product}/${area}/${dayRange}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "geopulse-globe/1.0" },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  const lines = text.trim().split("\n");
  const header = lines[0]?.split(",").map((h) => h.trim().toLowerCase()) ?? [];
  const iConf = header.indexOf("confidence");
  const iFrp = header.indexOf("frp");
  const iLat = header.indexOf("latitude");
  const iLon = header.indexOf("longitude");

  const confidenceCounts: Record<string, number> = {};
  let highConfidenceCount = 0;
  let totalFrp = 0;
  const cells = new Map<string, { count: number; totalFrp: number }>();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < header.length) continue;
    const raw = (cols[iConf] ?? "").trim().toLowerCase();
    confidenceCounts[raw] = (confidenceCounts[raw] ?? 0) + 1;
    const isHigh =
      raw === "h" || raw === "high" || (!Number.isNaN(Number(raw)) && Number(raw) >= 80);
    const frp = Number(cols[iFrp]) || 0;
    totalFrp += frp;
    if (!isHigh) continue;
    highConfidenceCount++;

    const lat = Number(cols[iLat]);
    const lon = Number(cols[iLon]);
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
    const key = `${Math.round(lat / GRID_SIZE)},${Math.round(lon / GRID_SIZE)}`;
    const existing = cells.get(key);
    if (existing) {
      existing.count++;
      existing.totalFrp += frp;
    } else {
      cells.set(key, { count: 1, totalFrp: frp });
    }
  }

  // Same flood-fill adjacency merge as firms.ts's clusterDetections, just
  // reporting sizes instead of building full Cluster objects.
  const visited = new Set<string>();
  const clusterSizes: { count: number; totalFrp: number }[] = [];
  for (const [key] of cells) {
    if (visited.has(key)) continue;
    const [gi0, gj0] = key.split(",").map(Number);
    const stack = [[gi0, gj0]];
    visited.add(key);
    let count = 0;
    let clusterFrp = 0;
    while (stack.length > 0) {
      const [gi, gj] = stack.pop()!;
      const cell = cells.get(`${gi},${gj}`)!;
      count += cell.count;
      clusterFrp += cell.totalFrp;
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          if (di === 0 && dj === 0) continue;
          const nKey = `${gi + di},${gj + dj}`;
          if (cells.has(nKey) && !visited.has(nKey)) {
            visited.add(nKey);
            stack.push([gi + di, gj + dj]);
          }
        }
      }
    }
    clusterSizes.push({ count, totalFrp: Math.round(clusterFrp) });
  }
  clusterSizes.sort((a, b) => b.count - a.count);

  return NextResponse.json({
    area,
    product,
    dayRange,
    ok: res.ok,
    status: res.status,
    firstLine: lines[0]?.slice(0, 300) ?? null,
    totalRows: lines.length - 1,
    confidenceCounts,
    highConfidenceCount,
    totalFrp: Math.round(totalFrp),
    clusterCount: clusterSizes.length,
    top5Clusters: clusterSizes.slice(0, 5),
    clustersPassingCurrentThreshold: clusterSizes.filter(
      (c) => c.count >= 8 && c.totalFrp >= 500,
    ).length,
  });
}
