import { NextRequest, NextResponse } from "next/server";
import {
  getArchiveSummary,
  getRecentDroppedItems,
  findVocabularyCandidates,
} from "@/lib/classificationArchive";

// Read-only, unauthenticated like /api/admin/health — nothing sensitive
// here, just aggregate counts and headlines already public on the outlets
// that published them.
//
// Deliberately a REPORT, not an auto-updater. This does not, and should
// not, write back into src/lib/classify.ts's severity/category patterns
// automatically:
//   - Every real vocabulary change this session (mobiliz/border incident
//     moved tiers, humanitarian/political-instability terms added, the
//     invasion/massacre bare-noun bugs) required actually reading example
//     headlines and judging whether a candidate phrase means what it looks
//     like it means — "captures" matching "footage captures the moment"
//     is exactly the kind of false-positive a frequency count alone can't
//     catch; only reading the examples caught it.
//   - This is an editorial-judgment classifier for a product whose whole
//     premise is being defensible to a skeptical reader (see AGENTS.md /
//     project standards) — letting it silently rewrite its own rules from
//     unsupervised pattern-mining of a public news firehose is also a
//     real manipulation surface (a bad-faith source could deliberately
//     flood specific vocabulary to get itself whitelisted).
//   - The existing discipline every change in classify.ts already
//     documents — live-test against real content, verify no false
//     positives, explain the reasoning in a comment — doesn't survive
//     being fully automated away.
// So: this surfaces ranked candidates with real example headlines: a
// human (or a future session) reviews and manually adds the ones that
// hold up, the same way every other vocabulary change so far was made.
export async function GET(req: NextRequest) {
  const daysParam = req.nextUrl.searchParams.get("days");
  const windowDays = daysParam
    ? Math.min(90, Math.max(1, Number(daysParam) || 7))
    : 7;

  const [summary, droppedItems] = await Promise.all([
    getArchiveSummary(windowDays),
    getRecentDroppedItems(windowDays),
  ]);

  const candidates = findVocabularyCandidates(droppedItems).slice(0, 50);

  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    summary,
    candidateCount: candidates.length,
    candidates,
  });
}
