import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { anomalyFindings } from "@/db/schema";

export interface AnomalyFindingResponse {
  signalType: string;
  country: string;
  category: string | null;
  observedValue: number;
  baselineMean: number;
  baselineStdDev: number;
  sampleSize: number;
  jump: number;
  zScore: number;
}

// Public, unauthenticated, read-only — same posture as /api/aircraft-
// anomalies and /api/risk. Returns the latest scan generation only (see
// anomalyFindings's own doc comment in src/db/schema.ts for why this is
// MAX(detectedAt), not a time window), grouped by country. Returns
// { detectedAt: null, findings: [] } if the daily scan hasn't run yet —
// not an error, just "no data yet," same shape the client already expects
// from every other anomaly-style endpoint.
//
// STALENESS_CUTOFF_MS (2026-09-11, user request): this route previously had
// no staleness check at all — if the daily snapshot-flights cron ever
// silently stopped firing, the UI's "unusual" badge would keep showing
// whatever the last real scan found, indefinitely, with nothing telling a
// viewer the data was no longer current. The scan is daily-cadence (see
// anomalyScan.ts), so one real missed day is normal operational noise, not
// a reason to hide findings; a week of silence is a genuinely different
// signal (the cron itself is broken) and gets treated the same as "no scan
// has ever run" — same response shape, no separate stale-flag plumbing
// needed on the client.
const STALENESS_CUTOFF_MS = 7 * 24 * 60 * 60_000;

export async function GET() {
  try {
    const db = getDb();
    const [latest] = await db
      .select({ detectedAt: sql<string | null>`max(${anomalyFindings.detectedAt})` })
      .from(anomalyFindings);

    if (!latest?.detectedAt) {
      return NextResponse.json({ detectedAt: null, findings: [] });
    }

    if (Date.now() - new Date(latest.detectedAt).getTime() > STALENESS_CUTOFF_MS) {
      return NextResponse.json({ detectedAt: null, findings: [] });
    }

    const rows = await db
      .select({
        signalType: anomalyFindings.signalType,
        country: anomalyFindings.country,
        category: anomalyFindings.category,
        observedValue: anomalyFindings.observedValue,
        baselineMean: anomalyFindings.baselineMean,
        baselineStdDev: anomalyFindings.baselineStdDev,
        sampleSize: anomalyFindings.sampleSize,
        jump: anomalyFindings.jump,
        zScore: anomalyFindings.zScore,
      })
      .from(anomalyFindings)
      .where(eq(anomalyFindings.detectedAt, new Date(latest.detectedAt)));

    return NextResponse.json({ detectedAt: latest.detectedAt, findings: rows });
  } catch (err) {
    console.error(`anomalies fetch failed: ${err}`);
    return NextResponse.json({ detectedAt: null, findings: [] });
  }
}
