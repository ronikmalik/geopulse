import { NextRequest } from "next/server";
import { getCountryHistory, summarizeHistory } from "@/lib/history";
import { badRequest, cachedJson, parseBoundedInt, parseCountryParam } from "@/lib/apiParams";

// Backs the Trends tab: a country's daily country_state_history snapshots
// plus a deterministic, computed-from-the-numbers summary (see
// summarizeHistory in src/lib/history.ts) — not a free-text/LLM answer.
// Snapshots are written once a day, so a 5-minute CDN cache can never
// hide a real change for long.
export async function GET(req: NextRequest) {
  const country = parseCountryParam(req.nextUrl.searchParams.get("country"));
  if (!country) return badRequest("country must be a 2-letter ISO code");
  const days = parseBoundedInt(req.nextUrl.searchParams.get("days"), 365, 1, 730);

  const history = await getCountryHistory(country, days);
  const summary = summarizeHistory(country, history);

  return cachedJson({ history, summary }, 300);
}
