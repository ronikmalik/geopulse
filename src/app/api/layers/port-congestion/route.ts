import { NextResponse } from "next/server";
import { fetchChokepointTransits } from "@/lib/sources/portwatch";
import { withCache } from "@/lib/layerCache";

// Updated weekly by IMF (Tuesdays) — long cache, no point re-fetching
// more often than the upstream data actually changes.
export async function GET() {
  try {
    const chokepoints = await withCache("layer:port-congestion", 6 * 60 * 60_000, () =>
      fetchChokepointTransits(),
    );
    return NextResponse.json({ chokepoints });
  } catch (err) {
    console.error(`layer:port-congestion failed: ${err}`);
    return NextResponse.json({ chokepoints: [] });
  }
}
