import { NextRequest, NextResponse } from "next/server";
import { runBackfill } from "@/lib/backfill";

export const maxDuration = 55;

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured yet (local dev) — allow
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

// Occasional/manual — not on the live ingest schedule. See
// src/lib/backfill.ts for what this does and why it's bounded to 30 days
// and to USGS + EONET only.
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runBackfill();
  return NextResponse.json(result);
}
