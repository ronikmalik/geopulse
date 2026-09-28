import { NextResponse } from "next/server";
import { fetchOoniInterference } from "@/lib/sources/ooni";
import { withCache } from "@/lib/layerCache";
import { cachedJson } from "@/lib/apiParams";

// OONI publishes measurements continuously, but a 7-day aggregate barely
// moves hour to hour; six hours in memory and one at the CDN keeps this to
// a handful of upstream calls a day. No database involved.
export async function GET() {
  try {
    const summary = await withCache("layer:internet-censorship", 6 * 60 * 60_000, () => fetchOoniInterference());
    return cachedJson(summary, 3600, 600);
  } catch (err) {
    console.error(`layer:internet-censorship failed: ${err}`);
    return NextResponse.json({ countries: [], error: "OONI data unavailable right now" });
  }
}
