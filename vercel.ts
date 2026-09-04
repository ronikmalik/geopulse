import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  crons: [
    // Primary ingest cadence is driven by cron-job.org hitting /api/ingest
    // directly (external config, not in this repo — see cronAuth.ts and
    // gdelt.ts for its constraints). The GitHub Actions workflow
    // (.github/workflows/ingest.yml) was originally meant to be primary but
    // its schedule trigger has never fired once (see its own header
    // comment); it now only runs via manual workflow_dispatch. This daily
    // Vercel cron is a third-tier floor in case both of those stop working
    // (Vercel Hobby plan caps custom cron at once/day, so it can't be more
    // than a floor).
    { path: "/api/ingest", schedule: "0 6 * * *" },
    // Daily country_state_history snapshot — see src/lib/history.ts.
    { path: "/api/admin/snapshot", schedule: "0 18 * * *" },
    // Daily per-country military aircraft count snapshot, building a real
    // baseline for future surge detection — see src/lib/flightBaseline.ts.
    { path: "/api/admin/snapshot-flights", schedule: "30 18 * * *" },
  ],
};
