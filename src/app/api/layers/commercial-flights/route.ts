import { NextResponse } from "next/server";
import { fetchAdsbLolCommercial } from "@/lib/sources/adsblol";
import { withCache } from "@/lib/layerCache";

// Switched from OpenSky to adsb.lol 2026-09-09 — OpenSky's bounding-box
// endpoint was confirmed live to be blocked/empty specifically from
// Vercel's shared outbound IP (see the old opensky.ts, removed in this
// change, for the original diagnosis), so this layer had been silently
// dead in production. adsb.lol is already proven reliable from this same
// environment (it powers the military "flights" layer) — see
// fetchAdsbLolCommercial's own comment for why it's several hub-point
// queries merged together rather than one global call.
export async function GET() {
  try {
    const aircraft = await withCache(
      "layer:commercial-flights",
      20_000,
      fetchAdsbLolCommercial,
    );
    return NextResponse.json({ aircraft });
  } catch (err) {
    console.error(`layer:commercial-flights failed: ${err}`);
    return NextResponse.json({ aircraft: [], error: String(err) });
  }
}
