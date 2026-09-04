import { NextRequest, NextResponse } from "next/server";
import { runBackfill } from "@/lib/backfill";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 55;

// Occasional/manual — not on the live ingest schedule. See
// src/lib/backfill.ts for what this does and why it's bounded to 30 days
// and to USGS + EONET only.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runBackfill();
  return NextResponse.json(result);
}
