import { NextResponse } from "next/server";
import { getRecentAlerts } from "@/lib/alertEngine";
import { cachedJson } from "@/lib/apiParams";

// Public, read-only. Ranked by tier then recency, so a reader with five
// minutes sees the most serious thing first — which is the entire point
// of the engine behind it.
//
// Every alert arrives with its own scoring breakdown and the events that
// drove it, because an alert you cannot interrogate is just an opinion
// with a colour. Cached 5 minutes: alerts are written by the review job
// once per pipeline cycle, so a viewer never costs a database wake-up.
export async function GET() {
  try {
    return cachedJson({ alerts: await getRecentAlerts() }, 300, 120);
  } catch (err) {
    console.error(`alerts fetch failed: ${err}`);
    return NextResponse.json({ alerts: [] });
  }
}
