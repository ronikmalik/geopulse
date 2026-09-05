import { NextResponse } from "next/server";
import { fetchOpenSkyStates } from "@/lib/sources/opensky";
import { withCache } from "@/lib/layerCache";

// See src/app/api/layers/flights/route.ts's 2026-09-04 comment — this was
// the route that actually crashed live (a 500 with no body) when OpenSky
// hiccuped, prompting the audit that found the same gap in every other
// layer route.
//
// Still degrades to a 200 with an empty list on failure (never break the
// panel), but now includes the real reason in an `error` field — found
// live (2026-09-04) that OpenSky was consistently failing from Vercel's
// shared outbound IP while working fine from elsewhere, and the previous
// silent-empty-array behavior made that indistinguishable from genuinely
// zero live aircraft over Europe/Middle East, which never happens.
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
    return NextResponse.json({ aircraft: [], error: String(err) });
  }
}
