import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  crons: [
    // The ONLY remaining Vercel cron (2026-09-19). Every scheduled pipeline
    // job — ingest, review-pending, generate-briefs, the daily snapshots,
    // the backlog audit, the weekly trainers — now runs in-process on
    // GitHub Actions runners (see .github/workflows/_run-job.yml and
    // scripts/run-job.ts) so none of that work spends Vercel Hobby's
    // metered Fluid compute, which was exceeded (4h49m / 4h Active CPU in
    // the 30 days to 2026-09-19, ~65% of it /api/ingest).
    //
    // This once-daily ingest is kept as a last-resort floor because it's
    // the one job that is fully idempotent (events dedupe by URL) AND the
    // one whose silence would be user-visible fastest if GitHub's schedule
    // trigger ever went quiet again the way it did 2026-08-27..09-04. The
    // daily snapshot/audit jobs are deliberately NOT here: snapshot
    // writes are not idempotent (one row per country per call), so they
    // must run from exactly one scheduler.
    { path: "/api/ingest", schedule: "0 6 * * *" },
  ],
};
