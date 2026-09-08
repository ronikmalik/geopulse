import { NextRequest, NextResponse } from "next/server";
import {
  getCountryRiskEvents,
  getCountryThreatDetail,
  getCountryThreatSummaries,
} from "@/lib/risk";
import { getLatestCountryBrief } from "@/lib/countryBriefs";

export async function GET(req: NextRequest) {
  const country = req.nextUrl.searchParams.get("country");

  if (country) {
    const [detail, eventsForCountry, brief] = await Promise.all([
      getCountryThreatDetail(country),
      getCountryRiskEvents(country),
      getLatestCountryBrief(country),
    ]);
    return NextResponse.json({ ...detail, events: eventsForCountry, brief });
  }

  const scores = await getCountryThreatSummaries();
  return NextResponse.json({ scores });
}
