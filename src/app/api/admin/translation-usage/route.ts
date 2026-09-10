import { NextResponse } from "next/server";
import { getUsageBudget, MONTHLY_BYTE_CAP } from "@/lib/translationUsage";

// Read-only, unauthenticated like /api/admin/health — nothing sensitive
// here, just byte counts, so no reason to require CRON_SECRET for a
// simple "how close to the cap are we" check.
export async function GET() {
  const budget = await getUsageBudget();
  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    monthlyCapBytes: MONTHLY_BYTE_CAP,
    ...budget,
  });
}
