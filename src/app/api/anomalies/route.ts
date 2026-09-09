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
export async function GET() {
  try {
    const db = getDb();
    const [latest] = await db
      .select({ detectedAt: sql<string | null>`max(${anomalyFindings.detectedAt})` })
      .from(anomalyFindings);

    if (!latest?.detectedAt) {
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
