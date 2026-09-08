import { NextRequest, NextResponse } from "next/server";
import { getAuditFindings } from "@/lib/classifierAudit";
import { isCronAuthorized } from "@/lib/cronAuth";

// The human review queue for src/lib/classifierAudit.ts's daily findings.
// CRON_SECRET-gated like other admin report routes — not sensitive
// exactly (same public headlines the outlets already published), but
// this is an internal editorial tool, not a public feed. Defaults to
// ?status=pending, the only status a reviewer actually needs to act on;
// pass ?status=approved etc. to look back at past decisions.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const status = req.nextUrl.searchParams.get("status") || "pending";
  const kind = req.nextUrl.searchParams.get("kind");
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Math.min(200, Math.max(1, Number(limitParam) || 50)) : 50;

  const findings = await getAuditFindings(status, kind, limit);
  return NextResponse.json({ count: findings.length, findings });
}
