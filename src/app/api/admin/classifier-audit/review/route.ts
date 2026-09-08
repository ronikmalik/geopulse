import { NextRequest, NextResponse } from "next/server";
import { reviewAuditFinding, type ReviewStatus } from "@/lib/classifierAudit";
import { isCronAuthorized } from "@/lib/cronAuth";

// The one write action in this feature. ?status=approved triggers a live
// action scoped to exactly this one article — see applyFinding in
// classifierAudit.ts: a false_negative gets inserted into the live feed,
// a false_positive gets removed from it. If that live action succeeds,
// the stored status becomes "applied" automatically (not just
// "approved") so the review queue shows "acted on" vs. "still needs a
// manual classify.ts fix" at a glance — some approvals can't be
// auto-applied (e.g. no resolvable country) and stay "approved" with a
// note explaining why. ?status=rejected and ?status=applied (marking a
// manual classify.ts change as shipped) are plain status updates with no
// live-feed side effect. GET-with-query-params to match every other
// admin mutation in this repo (admin/purge, admin/migrate) — simplest to
// trigger via the admin-call.yml GitHub Actions workflow, which has no
// request-body support.
//
// Optional ?overrideSeverity=<1-5> and/or ?overrideCountry=<alpha-2>
// (2026-09-08) let the reviewer apply ITS OWN corrected value instead of
// whatever Gemini suggested — see ReviewOverrides's doc comment in
// classifierAudit.ts. Calling this again with an override on a finding
// that's already "applied" genuinely re-applies with the new value; it's
// not a no-op.
const VALID_STATUSES = new Set<ReviewStatus>(["approved", "rejected", "applied"]);

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const idParam = req.nextUrl.searchParams.get("id");
  const id = idParam ? Number(idParam) : NaN;
  const statusParam = req.nextUrl.searchParams.get("status") ?? "";
  const note = req.nextUrl.searchParams.get("note");

  if (!Number.isInteger(id) || !VALID_STATUSES.has(statusParam as ReviewStatus)) {
    return NextResponse.json(
      { error: "requires ?id=<number> and ?status=approved|rejected|applied" },
      { status: 400 },
    );
  }

  const overrideSeverityParam = req.nextUrl.searchParams.get("overrideSeverity");
  const overrideCountryParam = req.nextUrl.searchParams.get("overrideCountry");
  const overrideSeverity = overrideSeverityParam ? Number(overrideSeverityParam) : undefined;
  if (overrideSeverityParam && (!Number.isInteger(overrideSeverity) || overrideSeverity! < 1 || overrideSeverity! > 5)) {
    return NextResponse.json({ error: "overrideSeverity must be an integer 1-5" }, { status: 400 });
  }
  const overrides =
    overrideSeverity != null || overrideCountryParam
      ? { severity: overrideSeverity, country: overrideCountryParam?.toUpperCase() }
      : undefined;

  const result = await reviewAuditFinding(id, statusParam as ReviewStatus, note, overrides);
  if (!result.found) return NextResponse.json({ error: "finding not found" }, { status: 404 });
  return NextResponse.json({ ok: true, id, applied: result.applied, note: result.note });
}
