import { NextResponse } from "next/server";
import { fetchOpenSkyStates } from "@/lib/sources/opensky";
import { withCache } from "@/lib/layerCache";

// See src/app/api/layers/flights/route.ts's 2026-09-04 comment — this was
// the route that actually crashed live (a 500 with no body) when OpenSky
// hiccuped, prompting the audit that found the same gap in every other
// layer route.
export async function GET() {
  try {
    const aircraft = await withCache(
      "layer:commercial-flights",
      20_000,
      () => fetchOpenSkyStates(),
    );
    return NextResponse.json({ aircraft });
  } catch (err) {
    console.error(`layer:commercial-flights failed: ${err}`);
    return NextResponse.json({ aircraft: [] });
  }
}
