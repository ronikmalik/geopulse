import { NextResponse } from "next/server";
import { getRecentSanctionsDeltas } from "@/lib/sanctions";
import { cachedJson } from "@/lib/apiParams";

// Public, read-only, same posture as every other /api/layers/* context
// route. Reads only rows the weekly sync already wrote — no upstream
// fetch happens on a page view, so opening this panel never pulls a
// 25 MB file or wakes the database for anything but one indexed query.
//
// Cached for an hour: the underlying rows change at most weekly, and the
// whole point of the long cache here is that a viewer never costs Neon a
// wake-up (see docs/ARCHITECTURE.md §12).
export async function GET() {
  try {
    return cachedJson({ deltas: await getRecentSanctionsDeltas() }, 3600, 600);
  } catch (err) {
    console.error(`layer:sanctions failed: ${err}`);
    return NextResponse.json({ deltas: [] });
  }
}
