import { NextRequest, NextResponse } from "next/server";
import { getSourceHealth } from "@/lib/sourceHealth";
import { isCronAuthorized } from "@/lib/cronAuth";

// A source counts as "stale" once its last successful fetch is more than
// this far behind its last attempt — i.e. attempts are still happening
// (ingestion is running) but this particular source hasn't returned data
// in a while. Set well above the self-triggered ~10-minute ingest cadence
// (see .github/workflows/ingest.yml) so ordinary gaps between site visits
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

// Gated since 2026-09-19: lastError strings can carry upstream URLs,
// status codes and internal timing detail — operational telemetry, not
// public data. Nothing in the front end reads this route.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
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
