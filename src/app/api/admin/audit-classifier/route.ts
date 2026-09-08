import { NextRequest, NextResponse } from "next/server";
import { runClassifierAudit } from "@/lib/classifierAudit";
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
  return NextResponse.json(result);
}
