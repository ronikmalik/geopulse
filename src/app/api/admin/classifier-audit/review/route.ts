import { NextRequest, NextResponse } from "next/server";
import { reviewAuditFinding, type ReviewStatus } from "@/lib/classifierAudit";
import { isCronAuthorized } from "@/lib/cronAuth";

// The one write action in this feature — marks a finding approved (a
// real classify.ts change should follow, made by hand, same as every
// other vocabulary change), rejected (Gemini's call didn't hold up), or
// applied (the classify.ts change has actually been made and shipped).
// GET-with-query-params to match every other admin mutation in this repo
// (admin/purge, admin/migrate) — simplest to trigger via the
// admin-call.yml GitHub Actions workflow, which has no request-body
// support.
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

  const ok = await reviewAuditFinding(id, statusParam as ReviewStatus, note);
  if (!ok) return NextResponse.json({ error: "finding not found" }, { status: 404 });
  return NextResponse.json({ ok: true, id, status: statusParam });
}
