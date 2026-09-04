import { NextRequest, NextResponse } from "next/server";
import { eq, or, like } from "drizzle-orm";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { isCronAuthorized } from "@/lib/cronAuth";
import { resolveCountryFromText } from "@/lib/countryNames";
import { COUNTRY_CENTROIDS } from "@/lib/countryCentroids";

export const maxDuration = 55;

// One-off/occasional — re-runs resolveCountryFromText against every stored
// event's title and corrects country (and, for gdelt/rss rows only,
// location/lat/lon too) for rows whose attribution changes. Built for the
// 2026-09-04 countryNames.ts fixes: (1) INSTITUTION_ACRONYM_TO_ALPHA2 (the
// case-sensitive \bUS\b/ICE/DHS/FBI/CIA/Pentagon/White House check) used to
// win regardless of position, so any story merely mentioning "US" — even a
// Russia-Ukraine story where the US was a bystander in "US-brokered talks"
// — got attributed to the US instead of the country the story was actually
// about, inflating the US's own Threat Level; (2) bare lowercase substring
// keys "uk"/"usa"/"uae" matched inside unrelated words ("Levuka", "Nusa
// Tenggara"), corrupting a chunk of USGS/EONET natural-hazard rows. New
// rows self-correct automatically; this fixes what's already stored.
//
// Scoped to only 'gdelt', 'usgs', 'eonet', and 'rss:*' sources — the ones
// that actually derive country from article/event text via
// resolveCountryFromText (classify.ts for gdelt/rss, or the source file
// itself for usgs/eonet). gdacs, firms, ioda, and telegram deliberately
// excluded: their country comes from structured data instead (GDACS's own
// affectedcountries field, FIRMS/IODA's coordinate-based geocoding,
// telegram's fixed per-channel country) — recomputing from title text for
// those would silently replace a correct, differently-sourced value with a
// wrong guess (confirmed via a real case: a GDACS multi-country drought
// alert's authoritative "CD" would have been overwritten with "KE", the
// first country the title happens to name).
//
// For gdelt/rss rows, location/lat/lon are updated to match the new
// country's centroid, mirroring classify.ts's own behavior at ingest time.
// For usgs/eonet rows, ONLY country is updated — their location/lat/lon
// are already precise (the actual quake/event coordinates, not a country
// centroid) and must not be overwritten with a coarser value.
//
// Defaults to a dry run (no writes) — pass ?apply=true to actually persist
// changes. Only touches title-derived country (the original RSS/GDELT
// snippet used as a classify-time fallback isn't persisted, so this can't
// perfectly replay the original decision when the title alone was
// ambiguous) and only rows where the recomputed country differs from what's
// stored and has a known centroid.
const TEXT_CLASSIFIED_SOURCES = ["gdelt", "usgs", "eonet"];

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
      source: events.source,
      title: events.title,
      country: events.country,
      location: events.location,
    })
    .from(events)
    .where(
      or(
        ...TEXT_CLASSIFIED_SOURCES.map((s) => eq(events.source, s)),
        like(events.source, "rss:%"),
      ),
    );

  const changes: {
    id: number;
    source: string;
    title: string;
    from: string | null;
    to: string;
  }[] = [];

  for (const row of rows) {
    const recomputed = resolveCountryFromText(row.title);
    if (!recomputed || recomputed === row.country) continue;
    const centroid = COUNTRY_CENTROIDS[recomputed];
    if (!centroid) continue;
    changes.push({ id: row.id, source: row.source, title: row.title, from: row.country, to: recomputed });
  }

  const toApply = changes.slice(0, Math.max(0, limit));

  if (apply) {
    for (const change of toApply) {
      const centroid = COUNTRY_CENTROIDS[change.to];
      const updateCentroidFields = change.source === "gdelt" || change.source.startsWith("rss:");
      await db
        .update(events)
        .set(
          updateCentroidFields
            ? { country: change.to, location: centroid.name, lat: centroid.lat, lon: centroid.lon }
            : { country: change.to },
        )
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
