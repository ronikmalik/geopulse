import { NextResponse } from "next/server";
import { fetchCftcPositioning } from "@/lib/sources/cftc";
import { withCache } from "@/lib/layerCache";

// See src/app/api/layers/flights/route.ts's 2026-09-04 comment.
export async function GET() {
  try {
    // COT reports publish weekly — cache generously.
    const positions = await withCache(
      "layer:cftc",
      6 * 60 * 60_000,
      fetchCftcPositioning,
    );
    return NextResponse.json({ positions });
  } catch (err) {
    console.error(`layer:cftc failed: ${err}`);
    return NextResponse.json({ positions: [] });
  }
}
