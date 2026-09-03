import { fetchUsgsEarthquakesHistorical } from "./sources/usgs";
import { fetchEonetHistorical } from "./sources/eonet";
import { insertDirectItems } from "./ingest";

// One-off/occasional historical backfill — NOT part of the regular ~10-
// minute live ingest cycle (see src/app/api/stream/route.ts). Populates
// real historical events for the Natural & Biological Hazards and Climate
// & Environment pillars so countries with no *recent* activity still show
// genuine history rather than an empty "no events" state.
//
// Deliberately USGS + EONET only, not GDELT/GDACS/RSS: both were verified
// working with real historical range queries this session (USGS's FDSN
// endpoint, EONET's status=all&days=N); GDELT and GDACS have been down for
// this entire session (confirmed via direct requests from multiple
// networks, not a code problem) and RSS feeds are a rolling live window
// with no historical archive to query at all — there's nothing to verify
// or backfill from either until GDELT/GDACS actually recover.
//
// 30 days, not "a few months": src/lib/risk.ts only looks at events from
// the last 30 days (LOOKBACK_DAYS) when computing current Threat
// Level/Momentum — backfilling further back would sit in the database
// without ever affecting what the live product shows, which is exactly
// the kind of "no consumer" data this app avoids elsewhere. Also, the
// existing severity-decay model (3-day half-life) means anything past
// ~2-3 weeks already contributes a negligible weight even within that
// window — this is about filling in real events the rolling live feeds
// missed before this session started ingesting, not stretching the
// model's memory.
const BACKFILL_DAYS = 30;

export interface BackfillResult {
  usgs: { fetched: number; inserted: number; error: string | null };
  eonet: { fetched: number; inserted: number; error: string | null };
}

export async function runBackfill(): Promise<BackfillResult> {
  const [usgsItems, eonetItems] = await Promise.all([
    fetchUsgsEarthquakesHistorical(BACKFILL_DAYS).catch((err) => {
      console.error(`Backfill USGS failed: ${err}`);
      return [];
    }),
    fetchEonetHistorical(BACKFILL_DAYS).catch((err) => {
      console.error(`Backfill EONET failed: ${err}`);
      return [];
    }),
  ]);

  const [usgsResult, eonetResult] = await Promise.all([
    insertDirectItems(usgsItems),
    insertDirectItems(eonetItems),
  ]);

  return {
    usgs: { fetched: usgsItems.length, ...usgsResult },
    eonet: { fetched: eonetItems.length, ...eonetResult },
  };
}
