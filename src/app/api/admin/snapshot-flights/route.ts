import { NextRequest, NextResponse } from "next/server";
import { snapshotAircraftCounts, snapshotCommercialAircraftCounts } from "@/lib/flightBaseline";
import { snapshotGpsJamming } from "@/lib/gpsJammingHistory";
import { runAnomalyScan } from "@/lib/anomalyScan";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 55;

// Daily cron (see vercel.ts) — records today's per-country tracked
// aircraft counts (military + commercial) and GPS/GNSS jamming counts,
// then runs the full anomaly scan across every signal (those three plus
// the two live-SQL event-volume signals) and writes qualifying findings.
// See src/lib/flightBaseline.ts, src/lib/gpsJammingHistory.ts,
// src/lib/anomalyScan.ts.
//
// All four writes share this one route/cron entry rather than each
// getting its own (2026-09-09 decision): Vercel's Hobby tier caps both
// cron frequency and total cron count, and every one of these signals is
// daily-cadence anyway — piggybacking here costs nothing today and avoids
// the cron-count question entirely. If this route ever risks its 55s
// budget as more signals are added later, the scan step is the one to
// split into its own route first (it depends on the other three having
// already run this same request, not on a fixed clock time).
//
// Each step runs independently — a failure in one (e.g. gpsjam.org
// temporarily down) shouldn't silently swallow the others' results, so
// every step is caught individually rather than the whole handler
// failing on the first error.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const errors: string[] = [];

  const military = await snapshotAircraftCounts().catch((err) => {
    errors.push(`military: ${err}`);
    return { inserted: 0, countriesSeen: 0 };
  });
  const commercial = await snapshotCommercialAircraftCounts().catch((err) => {
    errors.push(`commercial: ${err}`);
    return { inserted: 0, countriesSeen: 0 };
  });
  const gpsJamming = await snapshotGpsJamming().catch((err) => {
    errors.push(`gpsJamming: ${err}`);
    return { inserted: 0, countriesSeen: 0 };
  });
  const scan = await runAnomalyScan().catch((err) => {
    errors.push(`scan: ${err}`);
    return null;
  });

  return NextResponse.json({ military, commercial, gpsJamming, scan, errors });
}
