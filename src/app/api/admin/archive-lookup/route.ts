import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { classificationArchive } from "@/db/schema";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 55;
export const dynamic = "force-dynamic";

// Read-only debugging tool: classification_archive keeps the original
// title/snippet/severity/category for every scored item (kept or
// dropped), keyed by url — so a row purged from `events` (or never kept
// in the first place) can still have its real content inspected here.
// Recovering a wrongly-dropped/purged item into the live feed should go
// through the classifier-audit review flow instead (a false_negative
// finding → reviewAuditFinding → applyFinding in classifierAudit.ts),
// which — unlike this route's now-removed archive-restore companion —
// correctly updates classification_archive.kept and works for RSS/GDELT
// sources too, not just Telegram's fixed-per-channel-country shortcut.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "missing ?url=" }, { status: 400 });
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(classificationArchive)
    .where(eq(classificationArchive.url, url));

  return NextResponse.json({ row: rows[0] ?? null });
}
