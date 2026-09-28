import { NextResponse } from "next/server";
import { fetchRadarOutages, RadarNotConfiguredError } from "@/lib/sources/cloudflareRadar";
import { withCache } from "@/lib/layerCache";
import { cachedJson } from "@/lib/apiParams";

// Cloudflare adds or closes an outage annotation a few times a day at
// most; 15 minutes in memory and at the CDN is plenty. No database.
export async function GET() {
  try {
    const outages = await withCache("layer:internet-outages", 15 * 60_000, () => fetchRadarOutages());
    return cachedJson(
      { outages, attribution: "Cloudflare Radar (radar.cloudflare.com), CC BY-NC 4.0" },
      900,
      300,
    );
  } catch (err) {
    if (err instanceof RadarNotConfiguredError) {
      return NextResponse.json({ outages: [], error: "not configured yet (needs a Cloudflare Radar API token)" });
    }
    console.error(`layer:internet-outages failed: ${err}`);
    return NextResponse.json({ outages: [], error: "Cloudflare Radar unavailable right now" });
  }
}
