import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  crons: [
    // Primary ingest cadence is driven by the GitHub Actions workflow
    // (.github/workflows/ingest.yml, every 5 min). This daily cron is just
    // a failsafe in case that workflow is disabled or GitHub Actions is
    // down.
    { path: "/api/ingest", schedule: "0 6 * * *" },
    // Daily country_state_history snapshot — see src/lib/history.ts.
    { path: "/api/admin/snapshot", schedule: "0 18 * * *" },
    // Daily per-country military aircraft count snapshot, building a real
    // baseline for future surge detection — see src/lib/flightBaseline.ts.
    { path: "/api/admin/snapshot-flights", schedule: "30 18 * * *" },
  ],
};
