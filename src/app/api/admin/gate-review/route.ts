import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cronAuth";
import { getPendingGateSamples, gradeGateSample, getGateMetrics, sampleGateDecisions } from "@/lib/gateReview";

// Backs /admin/gate-review (the human grading page) — see src/lib/
// gateReview.ts for why this channel exists. GET is read-only (pending
// samples + running metrics). POST records a grade and may flip the
// sampled event's live status, so it takes the Bearer header only, like
// every other mutating admin route.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (req.nextUrl.searchParams.get("sample") === "1") {
    // Manual top-up of today's sample (the audit-classifier job does this
    // daily on its own).
    const result = await sampleGateDecisions();
    return NextResponse.json(result);
  }
  const [pending, metrics] = await Promise.all([getPendingGateSamples(), getGateMetrics()]);
  return NextResponse.json({ pending, metrics });
}

export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req, { headerOnly: true })) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { id?: unknown; verdict?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const id = typeof body.id === "number" && Number.isSafeInteger(body.id) && body.id > 0 ? body.id : null;
  const verdict = body.verdict === "correct" || body.verdict === "wrong" ? body.verdict : null;
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null;
  if (!id || !verdict) {
    return NextResponse.json({ error: "id (positive integer) and verdict ('correct' | 'wrong') are required" }, { status: 400 });
  }
  const result = await gradeGateSample(id, verdict, note);
  return NextResponse.json(result, { status: result.found ? 200 : 404 });
}
