import { NextRequest } from "next/server";
import {
  getCountryRiskEvents,
  getCountryThreatDetail,
  getCountryThreatSummaries,
} from "@/lib/risk";
import { getLatestCountryBrief } from "@/lib/countryBriefs";
import { badRequest, cachedJson, parseCountryParam } from "@/lib/apiParams";

// The globe's colour layer (every country's current score, no param) and
// the per-country risk panel (?country=XX). Scores only move when an
// ingest cycle inserts/approves events (~every 15 min), so 60s at the CDN
// is invisible to a viewer and turns N open tabs polling the globe into
// ~1 invocation/minute — this was the single most-invoked non-stream
// route on Vercel before the 2026-09-19 pass.
export async function GET(req: NextRequest) {
  const rawCountry = req.nextUrl.searchParams.get("country");

  if (rawCountry) {
    const country = parseCountryParam(rawCountry);
    if (!country) return badRequest("country must be a 2-letter ISO code");
    const [detail, eventsForCountry, brief] = await Promise.all([
      getCountryThreatDetail(country),
      getCountryRiskEvents(country),
      getLatestCountryBrief(country),
    ]);
    return cachedJson({ ...detail, events: eventsForCountry, brief }, 60);
  }

  const scores = await getCountryThreatSummaries();
  return cachedJson({ scores }, 60);
}
