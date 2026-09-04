import { NextResponse } from "next/server";
import { fetchForexRates } from "@/lib/sources/forex";
import { withCache } from "@/lib/layerCache";

// See src/app/api/layers/flights/route.ts's 2026-09-04 comment. This one
// backs the always-on Forex ticker (not gated behind a layer toggle), so a
// crash here would have broken the Live Wire tab's headline feature
// entirely rather than just one optional layer.
export async function GET() {
  try {
    const rates = await withCache("layer:forex", 5 * 60_000, fetchForexRates);
    return NextResponse.json({ rates });
  } catch (err) {
    console.error(`layer:forex failed: ${err}`);
    return NextResponse.json({ rates: [] });
  }
}
