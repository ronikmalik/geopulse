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
    // Low-tier FLOOR for AI country situation briefs (2026-09-11) — the
    // real driver is .github/workflows/generate-briefs.yml (~every
    // 15min, one country per call, same "GitHub Actions for anything
    // sub-daily" reasoning as ingest/review-pending's own floor comments)
    // since Vercel's Hobby-tier cron can't go more often than once/day.
    // This entry just guarantees at least one country gets a fresh brief
    // if that workflow ever stops firing. See src/lib/countryBriefs.ts.
    { path: "/api/admin/generate-briefs", schedule: "0 19 * * *" },
    // Daily full-sweep for the Gemini-assisted classifier BACKLOG audit
    // (corrections to already-published items) — this is now its ONLY
    // cadence (2026-09-10, explicit user instruction: severely
    // deprioritize this relative to the pre-publish gate below). It used
    // to also run as a small slice embedded in every runIngest cycle;
    // that was removed once real AI Studio dashboard data showed the
    // audit model peaking at 490/500 RPD, and this backlog sweep — post-
    // hoc corrections, not credibility-gating — is the lower-priority of
    // the two things competing for that budget. See src/lib/
    // classifierAudit.ts's own comment on runClassifierAudit.
    { path: "/api/admin/audit-classifier", schedule: "0 20 * * *" },
    // The PRE-PUBLISH Gemini gate (reviewPendingEvents) is NOT here — it
    // needs sub-daily, "always active" cadence (2026-09-10 user
    // instruction), which the Hobby plan's once/day cron cap can't give
    // it. It runs via .github/workflows/review-pending.yml instead
    // (~every 15min, GitHub Actions has no once-daily limit) — see that
    // workflow and GET /api/admin/review-pending for the full reasoning.
  ],
};
