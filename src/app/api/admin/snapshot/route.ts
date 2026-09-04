import { NextRequest, NextResponse } from "next/server";
import { snapshotCountryStates } from "@/lib/history";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 55;

// Daily cron (see vercel.ts) — records every country's current Pulse
// Level/momentum into country_state_history. See src/lib/history.ts.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await snapshotCountryStates();
  return NextResponse.json(result);
}
