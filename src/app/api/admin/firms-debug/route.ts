import { NextRequest, NextResponse } from "next/server";

// TEMPORARY diagnostic route — investigating why fetchFirmsThermalAnomalies
// has returned 0 items for several days despite a healthy source_health
// row. Unauthenticated like /api/admin/health (read-only aggregate counts,
// never the raw key or URL). ?area= lets us test "world" against a real
// bounding box to isolate a bad area keyword from a genuinely empty feed.
// Delete once diagnosed.
const FIRMS_ENDPOINT = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";

export async function GET(req: NextRequest) {
  const mapKey = process.env.FIRMS_MAP_KEY;
  if (!mapKey) return NextResponse.json({ error: "no key configured" });

  const area = req.nextUrl.searchParams.get("area") ?? "world";
  const url = `${FIRMS_ENDPOINT}/${mapKey}/VIIRS_SNPP_NRT/${area}/1`;
  const res = await fetch(url, {
    headers: { "User-Agent": "geopulse-globe/1.0" },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  const lines = text.trim().split("\n");
  const header = lines[0]?.split(",").map((h) => h.trim().toLowerCase()) ?? [];
  const iConf = header.indexOf("confidence");
  const iFrp = header.indexOf("frp");

  const confidenceCounts: Record<string, number> = {};
  let highConfidenceCount = 0;
  let totalFrp = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < header.length) continue;
    const raw = (cols[iConf] ?? "").trim().toLowerCase();
    confidenceCounts[raw] = (confidenceCounts[raw] ?? 0) + 1;
    const isHigh =
      raw === "h" || raw === "high" || (!Number.isNaN(Number(raw)) && Number(raw) >= 80);
    if (isHigh) highConfidenceCount++;
    totalFrp += Number(cols[iFrp]) || 0;
  }

  return NextResponse.json({
    area,
    ok: res.ok,
    status: res.status,
    firstLine: lines[0]?.slice(0, 300) ?? null,
    totalRows: lines.length - 1,
    confidenceCounts,
    highConfidenceCount,
    totalFrp: Math.round(totalFrp),
  });
}
