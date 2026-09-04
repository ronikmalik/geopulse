import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { isCronAuthorized } from "@/lib/cronAuth";
import { resolveCountryFromText } from "@/lib/countryNames";
import { COUNTRY_CENTROIDS } from "@/lib/countryCentroids";

export const maxDuration = 55;

// One-off/occasional — re-runs resolveCountryFromText against every stored
// event's title and corrects country/location/lat/lon for rows whose
// attribution changes. Built for the 2026-09-04 countryNames.ts fix: before
// that fix, INSTITUTION_ACRONYM_TO_ALPHA2 (the case-sensitive \bUS\b/ICE/
// DHS/FBI/CIA/Pentagon/White House check) always won regardless of
// position, so any story merely mentioning "US" — even a Russia-Ukraine
// story where the US was a bystander in "US-brokered talks" — got
// attributed to the US instead of the country the story was actually
// about. That inflated the US's own Threat Level with events that weren't
// really about the US. The fix makes institution mentions compete on
// earliest-position like everything else (plus a narrow override for
// "Iran hits US military targets"-style direct-attack phrasing, where the
// US genuinely is who the story is about). This endpoint re-derives
// country for already-ingested rows so the correction applies to live data,
// not just future ingests — new rows self-correct automatically and don't
// need this.
//
// Defaults to a dry run (no writes) — pass ?apply=true to actually persist
// changes. Only touches title-derived country (the original RSS/GDELT
// snippet used as a classify-time fallback isn't persisted, so this can't
// perfectly replay the original decision when the title alone was
// ambiguous) and only rows where the recomputed country differs from what's
// stored and has a known centroid.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const apply = req.nextUrl.searchParams.get("apply") === "true";
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : 200;

  const db = getDb();
  const rows = await db
    .select({
      id: events.id,
      title: events.title,
      country: events.country,
      location: events.location,
    })
    .from(events);

  const changes: {
    id: number;
    title: string;
    from: string | null;
    to: string;
  }[] = [];

  for (const row of rows) {
    const recomputed = resolveCountryFromText(row.title);
    if (!recomputed || recomputed === row.country) continue;
    const centroid = COUNTRY_CENTROIDS[recomputed];
    if (!centroid) continue;
    changes.push({ id: row.id, title: row.title, from: row.country, to: recomputed });
  }

  const toApply = changes.slice(0, Math.max(0, limit));

  if (apply) {
    for (const change of toApply) {
      const centroid = COUNTRY_CENTROIDS[change.to];
      await db
        .update(events)
        .set({
          country: change.to,
          location: centroid.name,
          lat: centroid.lat,
          lon: centroid.lon,
        })
        .where(eq(events.id, change.id));
    }
  }

  return NextResponse.json({
    apply,
    totalRowsScanned: rows.length,
    totalChangesFound: changes.length,
    changesApplied: apply ? toApply.length : 0,
    changes: toApply,
  });
}
