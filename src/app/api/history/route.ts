import { NextRequest, NextResponse } from "next/server";
import { getCountryHistory, summarizeHistory } from "@/lib/history";

// Backs the Trends tab: a country's daily country_state_history snapshots
// plus a deterministic, computed-from-the-numbers summary (see
// summarizeHistory in src/lib/history.ts) — not a free-text/LLM answer.
export async function GET(req: NextRequest) {
  const country = req.nextUrl.searchParams.get("country");
  if (!country) {
    return NextResponse.json({ error: "country is required" }, { status: 400 });
  }
  const daysParam = req.nextUrl.searchParams.get("days");
  const days = daysParam ? Math.min(730, Math.max(1, Number(daysParam) || 365)) : 365;

  const history = await getCountryHistory(country, days);
  const summary = summarizeHistory(country, history);

  return NextResponse.json({ history, summary });
}
