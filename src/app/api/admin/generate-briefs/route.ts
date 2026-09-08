import { NextRequest, NextResponse } from "next/server";
import { generateBriefsForActiveCountries } from "@/lib/countryBriefs";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 55;

// Daily cron (see vercel.ts) — generates an AI situation brief for each
// currently-active country. See src/lib/countryBriefs.ts.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await generateBriefsForActiveCountries();
  return NextResponse.json(result);
}
