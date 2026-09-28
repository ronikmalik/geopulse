import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { anomalyFindings } from "@/db/schema";
import { latestAnomalyScanSql } from "@/lib/sourceHealth";

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

// Served like /api/events/feed since 2026-09-28: an ISR route handler,
// regenerated when the runner purges it (after the daily scan, and after
// each ingest+review) rather than on a 5-minute CDN lifetime. Findings
// change once a day, yet any open tab re-queried them every 5-10 minutes,
// which alone could keep Neon from ever scaling to zero. Errors are thrown
// rather than answered with an empty list: ISR keeps the last good copy
// on a failed regeneration, where a cached empty 200 would have hidden
// every badge until the next regeneration.
export const revalidate = 21600;

export async function GET() {
  const db = getDb();
  const [latest] = await db
    .select({ detectedAt: latestAnomalyScanSql })
    .from(anomalyFindings);

  if (!latest?.detectedAt) {
    return Response.json({ detectedAt: null, findings: [] });
  }

  if (Date.now() - new Date(latest.detectedAt).getTime() > STALENESS_CUTOFF_MS) {
    return Response.json({ detectedAt: null, findings: [] });
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

  return Response.json({ detectedAt: latest.detectedAt, findings: rows });
}
