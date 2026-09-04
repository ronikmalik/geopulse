import { NextResponse } from "next/server";
import { fetchAdsbLolMilitary } from "@/lib/sources/adsblol";
import { withCache } from "@/lib/layerCache";

// 2026-09-04: audit found every /api/layers/* route except telegram's (the
// one that already loops with its own per-item try/catch) had no error
// handling at all — an upstream fetch failure crashed the whole route with
// a bare 500 instead of degrading gracefully, exactly what happened live
// to commercial-flights when OpenSky hiccuped. Soft-degrade to an empty
// list on failure, same as every other optional-source pattern in this
// app (FIRMS with no key, translate.ts, etc.) — a client-side layer that
// briefly shows nothing is far better than one that breaks the panel.
export async function GET() {
  try {
    const aircraft = await withCache("layer:flights", 15_000, fetchAdsbLolMilitary);
    return NextResponse.json({ aircraft });
  } catch (err) {
    console.error(`layer:flights failed: ${err}`);
    return NextResponse.json({ aircraft: [] });
  }
}
