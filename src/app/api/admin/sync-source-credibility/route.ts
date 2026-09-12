import { NextRequest, NextResponse } from "next/server";
import { syncSourceCredibility } from "@/lib/sourceCredibility";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 55;

// NOT on any cron — deliberately manual-trigger-only (2026-09-11). The
// MBFC_RAPIDAPI_KEY account backing this is hard-capped at 3 requests/
// month total; automating this onto even a monthly schedule is a real
// decision to make later, not a default. Call this by hand
// (GET /api/admin/sync-source-credibility) when a real refresh is
// actually wanted. See src/lib/sourceCredibility.ts for the full design.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await syncSourceCredibility();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
