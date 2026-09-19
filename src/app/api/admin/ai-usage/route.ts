import { NextRequest, NextResponse } from "next/server";
import { getRecentAiUsage } from "@/lib/aiUsage";
import { isCronAuthorized } from "@/lib/cronAuth";

// Read-only. Was unauthenticated ("just counts") until the 2026-09-19
// security pass — per-kind daily Gemini call counts are still operational
// telemetry that maps this app's exact quota headroom for anyone probing
// it, and nothing in the front end reads this route, so there's no reason
// to leave it open. Same CRON_SECRET gate as every other /api/admin/*.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const recent = await getRecentAiUsage();
  return NextResponse.json({ checkedAt: new Date().toISOString(), recent });
}
