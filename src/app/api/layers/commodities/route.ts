import { NextResponse } from "next/server";
import { fetchCommodityPrices } from "@/lib/sources/commodities";
import { withCache } from "@/lib/layerCache";

// Same always-on treatment as /api/layers/forex — this backs the Live Wire
// tab's commodities ticker, not a gated Context Layer, so a crash here
// degrades to an empty ticker rather than breaking the tab.
export async function GET() {
  try {
    const commodities = await withCache("layer:commodities", 5 * 60_000, fetchCommodityPrices);
    return NextResponse.json({ commodities });
  } catch (err) {
    console.error(`layer:commodities failed: ${err}`);
    return NextResponse.json({ commodities: [] });
  }
}
