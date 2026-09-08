import { NextRequest, NextResponse } from "next/server";
import { getCalibrationLessons, deactivateCalibrationLesson } from "@/lib/classifierAudit";
import { isCronAuthorized } from "@/lib/cronAuth";

// Visibility into the recursive-learning table (classifier_calibration —
// see its doc comment in schema.ts) — every lesson currently being
// injected into Gemini's audit prompts, with occurrences/provenance, so
// the reviewer can sanity-check what it's taught the system rather than
// that growing invisibly. Defaults to active-only (what's actually live
// in prompts right now); ?all=1 includes deactivated/retired lessons too.
//
// ?deactivate=<pattern> retires one lesson (soft-delete, reversible by
// re-recording the same pattern via reviewAuditFinding's lesson param) —
// use when a lesson turns out wrong or gets superseded by a more precise
// one covering the same ground.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const deactivatePattern = req.nextUrl.searchParams.get("deactivate");
  if (deactivatePattern) {
    const found = await deactivateCalibrationLesson(deactivatePattern);
    return NextResponse.json(found ? { ok: true, deactivated: deactivatePattern } : { error: "pattern not found" }, {
      status: found ? 200 : 404,
    });
  }

  const activeOnly = req.nextUrl.searchParams.get("all") !== "1";
  const lessons = await getCalibrationLessons(activeOnly);
  return NextResponse.json({ count: lessons.length, lessons });
}
