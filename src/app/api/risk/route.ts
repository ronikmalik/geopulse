import { NextRequest } from "next/server";
import {
  getCountryRiskEvents,
  getCountryThreatDetail,
  getCountryThreatSummaries,
} from "@/lib/risk";
import { getLatestCountryBrief } from "@/lib/countryBriefs";
import { badRequest, cachedJson, parseCountryParam } from "@/lib/apiParams";
import { SCORING_VERSION } from "@/lib/scoringMethod";

// The globe's colour layer (every country's current score, no param) and
// the per-country risk panel (?country=XX). Scores only move when an
// ingest cycle inserts/approves events (~every 15 min), so 60s at the CDN
// is invisible to a viewer and turns N open tabs polling the globe into
// ~1 invocation/minute — this was the single most-invoked non-stream
// route on Vercel before the 2026-09-19 pass.
export async function GET(req: NextRequest) {
  // Keep the calculation time in the cached payload, not the viewer's clock.
  const calculatedAt = new Date().toISOString();
  const rawCountry = req.nextUrl.searchParams.get("country");

  if (rawCountry) {
    const country = parseCountryParam(rawCountry);
    if (!country) return badRequest("country must be a 2-letter ISO code");
    const [detail, eventsForCountry, brief] = await Promise.all([
      getCountryThreatDetail(country),
      getCountryRiskEvents(country),
      getLatestCountryBrief(country),
    ]);
    return cachedJson({ ...detail, events: eventsForCountry, brief, calculatedAt, scoringVersion: SCORING_VERSION }, 300, 300);
  }

  // 15 min at the CDN (was 60s, 2026-09-21): the map polls this every
  // minute from every open tab, and each CDN miss is a Neon wake-up. The
  // scores only move with decay and with the pipeline's ~15-min cycles,
  // so a minute of freshness was buying nothing but compute hours.
  const scores = await getCountryThreatSummaries();
  return cachedJson({ scores, calculatedAt, scoringVersion: SCORING_VERSION }, 900, 300);
}
