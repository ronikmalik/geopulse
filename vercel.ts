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
    // Daily AI country situation briefs — deliberately after the pulse
    // snapshot above so it reflects the same day's already-computed
    // scores, and on its own schedule (not piggybacked on /api/ingest)
    // since it needs the full 55s admin-route budget for N sequential
    // Gemini calls, which /api/ingest's cron-job.org 30s external trigger
    // has no room for. See src/lib/countryBriefs.ts.
    { path: "/api/admin/generate-briefs", schedule: "0 19 * * *" },
    // Daily Gemini-assisted classifier audit — after briefs, on the same
    // 55s-admin-route-budget reasoning. See src/lib/classifierAudit.ts.
    { path: "/api/admin/audit-classifier", schedule: "0 20 * * *" },
  ],
};
