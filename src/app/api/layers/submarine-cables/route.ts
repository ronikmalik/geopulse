import { NextResponse } from "next/server";
import { fetchSubmarineCableSummary } from "@/lib/sources/submarineCables";
import { withCache } from "@/lib/layerCache";

// Static infrastructure metadata (cable/landing-point registry), not a
// live feed — TeleGeography updates it on their own schedule, not
// continuously. A long cache floor just avoids re-fetching ~1.9k landing
// points and ~700 cables on every panel open.
export async function GET() {
  try {
    const summary = await withCache("layer:submarine-cables", 6 * 60 * 60_000, () =>
      fetchSubmarineCableSummary(10),
    );
    return NextResponse.json({ summary });
  } catch (err) {
    console.error(`layer:submarine-cables failed: ${err}`);
    return NextResponse.json({ summary: null });
  }
}
