import { NextResponse } from "next/server";
import { getRecentAiUsage } from "@/lib/aiUsage";

// Read-only, unauthenticated like /api/admin/translation-usage — same
// "nothing sensitive, just counts" posture. Not a budget check the way
// that route is (see the doc comment on the ai_usage table in
// src/db/schema.ts for why there's no cap here to report against) — just
// visibility into whether the embedding/brief pipeline is actually
// running.
export async function GET() {
  const recent = await getRecentAiUsage();
  return NextResponse.json({ checkedAt: new Date().toISOString(), recent });
}
