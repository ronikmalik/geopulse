// In-process runner for every scheduled pipeline job (2026-09-19).
//
// Why this exists: Vercel Hobby's Fluid compute allowance (4h Active CPU /
// 360 GB-hr provisioned memory per month) was exceeded — 4h49m used at
// month's end — and the per-route breakdown put ~65% of that on
// /api/ingest and ~26% on the old SSE /api/stream. The scheduled jobs
// never needed to run ON Vercel; GitHub Actions was already the scheduler
// (see .github/workflows/*.yml), it just curl'd a Vercel route and made
// Vercel do the work. This repo is PUBLIC, so GitHub Actions minutes are
// unlimited and free — running the job directly on the Actions runner
// against Neon moves the entire pipeline's compute off Vercel's metered
// budget. Vercel is left serving the UI and the cheap, CDN-cached read
// routes, which is all a Hobby plan is really for.
//
// Every job below is the SAME function its /api/admin/* route calls (those
// routes are kept — they're the manual/one-off entry points via
// .github/workflows/admin-call.yml, and the daily vercel.ts cron floors
// still hit them as a last-resort fallback if Actions ever goes quiet the
// way it did for a week in 2026-08/09). Nothing in src/lib/ knows or cares
// whether it's running under Next's route handler or a bare Node process:
// the DB client is the Neon HTTP driver (plain fetch), every upstream call
// is fetch, and the Gemini daily caps are enforced in the ai_usage table,
// not per-process — so cadence/budget behaviour is identical.
//
// Usage: npx tsx scripts/run-job.ts <job>
// Env:   DATABASE_URL (required), GEMINI_API_KEY, GOOGLE_TRANSLATE_API_KEY,
//        FIRMS_MAP_KEY, EIA_API_KEY, GEMINI_*_MODEL — the same names Vercel
//        holds (see .env.example), provided as GitHub Actions secrets.
//
// process.exit() at the end is deliberate, not sloppiness: several
// enrichment steps race a fetch against a deadline and ABANDON the loser
// (see withDeadline in src/lib/ingest.ts) — those dangling promises would
// otherwise keep the event loop alive until their own socket timeouts,
// wasting runner minutes for nothing.

import { runIngest } from "../src/lib/ingest";
import { reviewPendingEvents, runClassifierAudit } from "../src/lib/classifierAudit";
import { generateBriefsForActiveCountries } from "../src/lib/countryBriefs";
import { snapshotCountryStates } from "../src/lib/history";
import { gradeResolvedPredictions } from "../src/lib/riskModelGrading";
import { snapshotAircraftCounts, snapshotCommercialAircraftCounts } from "../src/lib/flightBaseline";
import { snapshotGpsJamming } from "../src/lib/gpsJammingHistory";
import { runAnomalyScan } from "../src/lib/anomalyScan";
import { trainAndShadowPredict } from "../src/lib/riskModel";
import { trainNarrativeClusters } from "../src/lib/narrativeTraining";
import { trainAndEvaluateTextClassifier } from "../src/lib/textClassifierTraining";
import { syncSourceCredibility } from "../src/lib/sourceCredibility";

// Hard ceiling on any single job so a hung upstream can never pin a runner
// for the workflow's full timeout-minutes. Generous relative to the Vercel
// routes' 55-120s maxDuration — there's no serverless clock to fight here,
// so the jobs get the room their internal deadlines were always sized
// against, plus real margin.
const JOB_TIMEOUT_MS = 8 * 60_000;

const JOBS: Record<string, () => Promise<unknown>> = {
  ingest: () => runIngest(),
  "review-pending": () => reviewPendingEvents(),
  "generate-briefs": () => generateBriefsForActiveCountries(),
  // Mirrors src/app/api/admin/snapshot/route.ts exactly: grading failure
  // must never mask a successful snapshot write.
  snapshot: async () => {
    const snapshot = await snapshotCountryStates();
    const grading = await gradeResolvedPredictions().catch((err) => {
      console.error(`riskModelGrading failed: ${err}`);
      return { graded: 0, ungraded: 0 };
    });
    return { snapshot, grading };
  },
  // Mirrors src/app/api/admin/snapshot-flights/route.ts.
  "snapshot-flights": async () => {
    const errors: string[] = [];
    const military = await snapshotAircraftCounts().catch((err) => {
      errors.push(`military: ${err}`);
      return { inserted: 0, countriesSeen: 0 };
    });
    const commercial = await snapshotCommercialAircraftCounts().catch((err) => {
      errors.push(`commercial: ${err}`);
      return { inserted: 0, countriesSeen: 0 };
    });
    const gpsJamming = await snapshotGpsJamming().catch((err) => {
      errors.push(`gpsJamming: ${err}`);
      return { inserted: 0, countriesSeen: 0 };
    });
    const scan = await runAnomalyScan().catch((err) => {
      errors.push(`scan: ${err}`);
      return null;
    });
    return { military, commercial, gpsJamming, scan, errors };
  },
  "audit-classifier": () => runClassifierAudit(),
  "train-risk-model": () => trainAndShadowPredict(),
  "train-narrative-clusters": () => trainNarrativeClusters(),
  "train-text-classifier": () => trainAndEvaluateTextClassifier(),
  "sync-source-credibility": () => syncSourceCredibility(),
};

async function main() {
  const name = process.argv[2];
  const job = name ? JOBS[name] : undefined;
  if (!job) {
    console.error(`Unknown job "${name ?? ""}". Known jobs: ${Object.keys(JOBS).join(", ")}`);
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — refusing to run against nothing.");
    process.exit(2);
  }

  const startedAt = Date.now();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`job "${name}" exceeded ${JOB_TIMEOUT_MS}ms`)), JOB_TIMEOUT_MS),
  );
  const result = await Promise.race([job(), timeout]);
  console.log(JSON.stringify({ job: name, elapsedMs: Date.now() - startedAt, result }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
