import { NextRequest, NextResponse } from "next/server";
import { ANOMALY_SCAN_SOURCE, getSourceHealth } from "@/lib/sourceHealth";
import { isCronAuthorized } from "@/lib/cronAuth";

// A source is "stale" once its last success is this far in the past —
// measured against now, not only against its last attempt (2026-09-28):
// comparing the two alone reported "ok" forever once scheduling stopped,
// since both timestamps then stop moving together. Ingest runs every 15-30
// minutes and GitHub-scheduled runs are often late, so two hours is four
// or more missed runs, not ordinary jitter. The anomaly scan is daily.
const STALE_AFTER_MS = 2 * 60 * 60_000;
const ANOMALY_SCAN_STALE_AFTER_MS = 48 * 60 * 60_000;

function statusFor(row: {
  source: string;
  lastAttemptAt: Date;
  lastSuccessAt: Date | null;
}): "ok" | "stale" | "never_succeeded" {
  if (!row.lastSuccessAt) return "never_succeeded";
  const threshold = row.source === ANOMALY_SCAN_SOURCE ? ANOMALY_SCAN_STALE_AFTER_MS : STALE_AFTER_MS;
  const gapMs = Math.max(Date.now(), row.lastAttemptAt.getTime()) - row.lastSuccessAt.getTime();
  return gapMs > threshold ? "stale" : "ok";
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
