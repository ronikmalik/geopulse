import { NextResponse } from "next/server";
import { fetchAirQuality } from "@/lib/sources/openaq";
import { withCache } from "@/lib/layerCache";

// See src/app/api/layers/flights/route.ts's 2026-09-04 comment. 30min TTL:
// ground-station PM2.5 doesn't swing meaningfully faster than that, and it
// keeps this well inside OpenAQ's per-key rate limit regardless of how
// many clients are polling.
export async function GET() {
  try {
    const readings = await withCache("layer:air-quality", 30 * 60_000, () =>
      fetchAirQuality(),
    );
    return NextResponse.json({ readings });
  } catch (err) {
    console.error(`layer:air-quality failed: ${err}`);
    return NextResponse.json({ readings: [] });
  }
}
