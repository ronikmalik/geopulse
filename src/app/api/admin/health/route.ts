import { NextResponse } from "next/server";
import { getSourceHealth } from "@/lib/sourceHealth";

// A source counts as "stale" once its last successful fetch is more than
// this far behind its last attempt — i.e. attempts are still happening
// (ingestion is running) but this particular source hasn't returned data
// in a while. Set well above the self-triggered ~10-minute ingest cadence
// (see src/app/api/stream/route.ts) so ordinary gaps between site visits
// don't read as an outage.
const STALE_AFTER_MS = 60 * 60_000;

function statusFor(row: {
  lastAttemptAt: Date;
  lastSuccessAt: Date | null;
}): "ok" | "stale" | "never_succeeded" {
  if (!row.lastSuccessAt) return "never_succeeded";
  const gapMs = row.lastAttemptAt.getTime() - row.lastSuccessAt.getTime();
  return gapMs > STALE_AFTER_MS ? "stale" : "ok";
}

export async function GET() {
  const rows = await getSourceHealth();
  const sources = rows.map((r) => ({
    source: r.source,
    status: statusFor(r),
    lastAttemptAt: r.lastAttemptAt,
    lastSuccessAt: r.lastSuccessAt,
    lastItemCount: r.lastItemCount,
    lastLatencyMs: r.lastLatencyMs,
    lastError: r.lastError,
    lastErrorAt: r.lastErrorAt,
  }));

  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    sources,
  });
}
