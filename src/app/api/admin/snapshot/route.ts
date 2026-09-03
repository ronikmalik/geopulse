import { NextRequest, NextResponse } from "next/server";
import { snapshotCountryStates } from "@/lib/history";

export const maxDuration = 55;

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured yet (local dev) — allow
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

// Daily cron (see vercel.json) — records every country's current Pulse
// Level/momentum into country_state_history. See src/lib/history.ts.
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await snapshotCountryStates();
  return NextResponse.json(result);
}
