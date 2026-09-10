import { NextRequest, NextResponse } from "next/server";
import { trainNarrativeClusters } from "@/lib/narrativeTraining";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 55;

// Weekly cron via .github/workflows/train-narrative-clusters.yml — same
// GitHub-Actions-not-vercel.ts reasoning as train-risk-model.yml's own doc
// comment. Re-fits spherical k-means (src/lib/narrativeClustering.ts) over
// feed_archive's embedded corpus from scratch each run, replacing the
// prior cluster map entirely, and scores that same training corpus against
// the fresh clusters (retrospective novelty findings). New items arriving
// between weekly runs get scored incrementally against whatever map is
// currently latest — see src/lib/narrativeNoveltyScoring.ts, called from
// every runIngest cycle. Nothing here is user-facing yet.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await trainNarrativeClusters();
  return NextResponse.json({ result });
}
