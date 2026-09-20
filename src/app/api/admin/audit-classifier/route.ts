import { NextRequest, NextResponse } from "next/server";
import { runClassifierAudit } from "@/lib/classifierAudit";
import { sampleGateDecisions } from "@/lib/gateReview";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 55;

// Daily cron (see vercel.ts) — Gemini reads recent classification_archive
// rows (both kept and dropped) and flags likely misclassifications into
// classifier_audit. See src/lib/classifierAudit.ts for the full design
// and, critically, why this never writes to classify.ts itself. GET
// /api/admin/classifier-audit is the human review queue this feeds.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runClassifierAudit();
  // Mirrors scripts/run-job.ts's audit-classifier job — see gateReview.ts.
  const gateSample = await sampleGateDecisions().catch((err) => {
    console.error(`sampleGateDecisions failed: ${err}`);
    return { sampled: 0, approved: 0, rejected: 0 };
  });
  return NextResponse.json({ ...result, gateSample });
}
