import { NextRequest, NextResponse } from "next/server";
import { snapshotAircraftCounts } from "@/lib/flightBaseline";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 55;

// Daily cron (see vercel.ts) — records today's per-country tracked
// military aircraft counts into aircraft_count_history. See
// src/lib/flightBaseline.ts.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await snapshotAircraftCounts();
  return NextResponse.json(result);
}
