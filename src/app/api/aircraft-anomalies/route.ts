import { NextResponse } from "next/server";
import { getAircraftAnomalies } from "@/lib/flightBaseline";

// Public, unauthenticated, read-only — same posture as /api/risk and
// /api/history (a computed public signal, not a control action). Backs
// the small "unusual aircraft activity" badge in CountryRiskPanel. See
// src/lib/flightBaseline.ts for why this returns [] for weeks after a
// fresh deploy: each country needs its own 14+ days of daily baseline
// samples before this can say anything statistically honest.
export async function GET() {
  try {
    const anomalies = await getAircraftAnomalies();
    return NextResponse.json({ anomalies });
  } catch (err) {
    console.error(`aircraft-anomalies failed: ${err}`);
    return NextResponse.json({ anomalies: [] });
  }
}
