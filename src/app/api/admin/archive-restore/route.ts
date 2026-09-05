import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { classificationArchive } from "@/db/schema";
import { isCronAuthorized } from "@/lib/cronAuth";
import { insertDirectItems } from "@/lib/ingest";
import { COUNTRY_CENTROIDS } from "@/lib/countryCentroids";
import type { Category } from "@/lib/categories";
import type { DirectItem } from "@/lib/sources/direct";

export const maxDuration = 55;
export const dynamic = "force-dynamic";

// Companion to /api/admin/archive-lookup — re-inserts a single row into
// `events` from its classification_archive record. Built for exactly the
// situation that motivated it (2026-09-05): a classifier correction
// purged rows under an over-broad rule, a follow-up correction showed
// some should have stayed, and their only surviving record was the
// archive. Only meaningful for Telegram sources today (the only ones
// whose archived category always corresponds to a single fixed country —
// see TELEGRAM_CHANNELS in src/lib/sources/telegram.ts); GDELT/RSS rows
// don't carry a stored country and would need a real re-classification
// pass instead of this shortcut.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.searchParams.get("url");
  const country = req.nextUrl.searchParams.get("country");
  if (!url || !country) {
    return NextResponse.json({ error: "missing ?url= or ?country=" }, { status: 400 });
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(classificationArchive)
    .where(eq(classificationArchive.url, url));
  const archived = rows[0];
  if (!archived) {
    return NextResponse.json({ error: "no archive row for that url" }, { status: 404 });
  }
  if (!archived.category) {
    return NextResponse.json(
      { error: "archived row has no category (was never kept at ingestion time)" },
      { status: 400 },
    );
  }

  const centroid = COUNTRY_CENTROIDS[country.toUpperCase()];
  if (!centroid) {
    return NextResponse.json({ error: `unknown country ${country}` }, { status: 400 });
  }

  const item: DirectItem = {
    source: archived.source,
    url: archived.url,
    title: archived.title,
    summary: archived.title,
    category: archived.category as Category,
    location: centroid.name,
    country: country.toUpperCase(),
    lat: centroid.lat,
    lon: centroid.lon,
    severity: archived.severity,
    publishedAt: archived.publishedAt,
  };

  const result = await insertDirectItems([item]);
  return NextResponse.json({ url, inserted: result.inserted, error: result.error });
}
