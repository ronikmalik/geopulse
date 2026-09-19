import { NextRequest, NextResponse } from "next/server";
import { getUsageBudget, MONTHLY_BYTE_CAP } from "@/lib/translationUsage";
import { isCronAuthorized } from "@/lib/cronAuth";

// Read-only. Gated since 2026-09-19 (same reasoning as /api/admin/
// ai-usage): quota headroom is operational telemetry, and no front-end
// code reads this route.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const budget = await getUsageBudget();
  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    monthlyCapBytes: MONTHLY_BYTE_CAP,
    ...budget,
  });
}
