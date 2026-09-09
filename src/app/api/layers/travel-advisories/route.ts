import { NextResponse } from "next/server";
import { fetchElevatedAdvisories } from "@/lib/sources/travelAdvisories";
import { withCache } from "@/lib/layerCache";

// State Dept updates this feed a few times a week, not continuously — a
// long cache (same order as GDP/population's daily World Bank data) avoids
// re-fetching and re-parsing the full ~200-entry feed on every panel open.
export async function GET() {
  try {
    const advisories = await withCache("layer:travel-advisories", 6 * 60 * 60_000, () =>
      fetchElevatedAdvisories(15),
    );
    return NextResponse.json({ advisories });
  } catch (err) {
    console.error(`layer:travel-advisories failed: ${err}`);
    return NextResponse.json({ advisories: [] });
  }
}
