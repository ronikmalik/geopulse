import { NextResponse } from "next/server";
import { fetchTopTradePartners } from "@/lib/sources/comtrade";
import { withCache } from "@/lib/layerCache";

// A small, geopolitically-representative curated set — not "top N by
// GDP", specifically countries whose trade DEPENDENCIES are themselves a
// live risk signal (e.g. who China/Russia/Iran actually sell to matters
// more here than who has the biggest economy). Kept short deliberately:
// src/lib/sources/comtrade.ts's own comment notes a 429 after just 2
// back-to-back preview-tier requests in testing, so this list stays
// small and the route below spaces requests rather than firing them
// concurrently.
const CURATED_REPORTERS = ["US", "CN", "RU", "DE", "SA", "IN"];
const REQUEST_SPACING_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET() {
  try {
    const summaries = await withCache("layer:trade-balance", 24 * 60 * 60_000, async () => {
      const results = [];
      for (let i = 0; i < CURATED_REPORTERS.length; i++) {
        if (i > 0) await sleep(REQUEST_SPACING_MS);
        const summary = await fetchTopTradePartners(CURATED_REPORTERS[i]).catch((err) => {
          console.error(`trade-balance fetch failed for ${CURATED_REPORTERS[i]}: ${err}`);
          return null;
        });
        if (summary) results.push(summary);
      }
      return results;
    });
    return NextResponse.json({ countries: summaries });
  } catch (err) {
    console.error(`layer:trade-balance failed: ${err}`);
    return NextResponse.json({ countries: [] });
  }
}
