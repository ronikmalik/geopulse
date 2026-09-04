import { NextResponse } from "next/server";
import { fetchOpenMeteoConditions } from "@/lib/sources/openmeteo";
import { withCache } from "@/lib/layerCache";

// See src/app/api/layers/flights/route.ts's 2026-09-04 comment.
export async function GET() {
  try {
    const conditions = await withCache(
      "layer:weather",
      5 * 60_000,
      fetchOpenMeteoConditions,
    );
    return NextResponse.json({ conditions });
  } catch (err) {
    console.error(`layer:weather failed: ${err}`);
    return NextResponse.json({ conditions: [] });
  }
}
