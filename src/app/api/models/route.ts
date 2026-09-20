import { NextResponse } from "next/server";
import { cachedJson } from "@/lib/apiParams";
import { getModelRegistrySummary } from "@/lib/modelRegistry";

// Public, read-only: every model the pipeline trains, its latest held-out
// numbers beside the naive baseline it had to beat, its live graded track
// record, and the human gate-grading stats. Nothing here is a secret —
// the point of the page is that a sceptic can see the same numbers the
// promotion gate sees. Cached an hour at the CDN; the underlying rows
// change at most daily.
export async function GET() {
  try {
    return cachedJson(await getModelRegistrySummary(), 3600, 600);
  } catch (err) {
    console.error(`models summary failed: ${err}`);
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
