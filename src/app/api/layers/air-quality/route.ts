import { NextResponse } from "next/server";
import { fetchAirQuality } from "@/lib/sources/openMeteoAirQuality";
import { withCache } from "@/lib/layerCache";

// See src/app/api/layers/flights/route.ts's 2026-09-04 comment. Switched
// from OpenAQ to Open-Meteo 2026-09-09 — OPENAQ_API_KEY had never actually
// been set, so this layer had been returning zero readings since it
// shipped (openaq.ts's own v3 API requires a key for every request, no
// free unauthenticated tier). 30min TTL: PM2.5 doesn't swing meaningfully
// faster than that.
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
