import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { classificationArchive } from "@/db/schema";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 55;
export const dynamic = "force-dynamic";

// One-off recovery tool: classification_archive keeps the original
// title/snippet/severity/category for every scored item (kept or
// dropped), keyed by url — so a row that was correctly re-classified as
// "no longer meets the standard" and purged from `events` can still have
// its real content looked up here, instead of being unrecoverable once
// deleted. Built for exactly this (2026-09-05): two Telegram posts were
// purged under an over-broad rule change before a follow-up correction
// showed they should have stayed; this recovers their original text so
// they can be re-inserted correctly rather than lost outright.
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
