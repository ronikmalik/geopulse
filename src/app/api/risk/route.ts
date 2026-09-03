import { NextRequest, NextResponse } from "next/server";
import {
  getCountryRiskEvents,
  getCountryThreatDetail,
  getCountryThreatSummaries,
} from "@/lib/risk";

export async function GET(req: NextRequest) {
  const country = req.nextUrl.searchParams.get("country");

  if (country) {
    const [detail, eventsForCountry] = await Promise.all([
      getCountryThreatDetail(country),
      getCountryRiskEvents(country),
    ]);
    return NextResponse.json({ ...detail, events: eventsForCountry });
  }

  const scores = await getCountryThreatSummaries();
  return NextResponse.json({ scores });
}
