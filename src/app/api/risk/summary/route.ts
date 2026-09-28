import { getCountryThreatSummaries } from "@/lib/risk";
import { SCORING_VERSION } from "@/lib/scoringMethod";

// Every country's current score for the globe's colour layer, served the
// same way as /api/events/feed (2026-09-28): an ISR route handler that
// reads no request data, regenerated when the pipeline purges it after
// each ingest+review (POST /api/admin/revalidate, which the runner follows
// with a GET so the regeneration happens while the database is already
// awake). Before, /api/risk carried this on a 15-minute CDN lifetime, so
// any open tab re-ran the whole scoring query every 15 minutes on its own
// clock, often waking Neon between pipeline runs just to recompute
// numbers that only change when the pipeline runs.
//
// A thrown error keeps the last good copy (ISR does not store failures),
// so a database hiccup can never blank the globe. REVALIDATE_SECONDS is
// only the safety net if purges stop arriving.
export const revalidate = 3600;

export async function GET() {
  const calculatedAt = new Date().toISOString();
  const scores = await getCountryThreatSummaries();
  return Response.json({ scores, calculatedAt, scoringVersion: SCORING_VERSION });
}
