import { NextResponse } from "next/server";
import { fetchGpsJammingSummary } from "@/lib/sources/gpsjam";
import { withCache } from "@/lib/layerCache";

// gpsjam.org publishes once per day (UTC), so an hourly cache floor is
// purely about not hammering their CSV endpoints on every panel open —
// the underlying data itself won't actually change more often than daily.
export async function GET() {
  try {
    const summary = await withCache("layer:gps-jamming", 60 * 60_000, () =>
      fetchGpsJammingSummary(10),
    );
    return NextResponse.json({ summary });
  } catch (err) {
    console.error(`layer:gps-jamming failed: ${err}`);
    return NextResponse.json({ summary: null });
  }
}
