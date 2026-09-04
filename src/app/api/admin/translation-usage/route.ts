import { NextResponse } from "next/server";
import { getUsageBudget, MONTHLY_CHAR_CAP } from "@/lib/translationUsage";

// Read-only, unauthenticated like /api/admin/health — nothing sensitive
// here, just character counts, so no reason to require CRON_SECRET for a
// simple "how close to the cap are we" check.
export async function GET() {
  const budget = await getUsageBudget();
  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    monthlyCap: MONTHLY_CHAR_CAP,
    ...budget,
  });
}
