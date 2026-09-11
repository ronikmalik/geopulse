import { NextRequest, NextResponse } from "next/server";
import { generateBriefsForActiveCountries } from "@/lib/countryBriefs";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 55;

// Frequent cadence (see .github/workflows/generate-briefs.yml, ~every
// 15min) — generates AI situation brief for exactly ONE active country
// per call, highest-risk-score-first, skipping anything already fresh.
// vercel.ts's own once-daily entry is kept as a low-tier floor (same
// "in case the primary driver ever stops" reasoning as ingest's daily
// Vercel cron). See src/lib/countryBriefs.ts for the full design.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await generateBriefsForActiveCountries();
  return NextResponse.json(result);
}
