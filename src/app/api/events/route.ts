import { NextRequest, NextResponse } from "next/server";
import { getEventsByCountry } from "@/lib/risk";

// Backs the country-drill-down Feed view (clicking a country on the globe).
// Separate from /api/stream, which only ever holds a shared, cross-country
// recent-N buffer client-side — this queries the DB scoped to one country
// so a country whose events fell out of that buffer still shows its feed.
export async function GET(req: NextRequest) {
  const country = req.nextUrl.searchParams.get("country");
  if (!country) {
    return NextResponse.json({ error: "country is required" }, { status: 400 });
  }
  const events = await getEventsByCountry(country);
  return NextResponse.json({ events });
}
