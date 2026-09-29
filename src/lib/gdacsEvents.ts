import { and, eq, inArray, like, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { correlationGroupId } from "./correlation";
import type { DirectItem } from "./sources/direct";
import { canonicalGdacsUrl } from "./sources/gdacs";

// A GDACS disaster is one row for its whole life (see sources/gdacs.ts).
// When a later episode changes it — the alert level moves, the cyclone
// tracks toward another coast — the stored row takes the new values
// rather than a second row appearing. published_at stays GDACS's own
// start date, so the score still decays from when the disaster began.
// A moved point clears population_exposed so exposureBackfill.ts
// recomputes it for the new location on the next review pass.
export async function refreshGdacsEvents(items: DirectItem[]): Promise<number> {
  const gdacs = items.filter((i) => i.source === "gdacs");
  if (gdacs.length === 0) return 0;
  const values = sql.join(
    gdacs.map((i) => {
      const country = i.country ? i.country.toUpperCase() : null;
      const group = country ? correlationGroupId(country, i.category, i.publishedAt) : null;
      return sql`(${i.url}, ${i.title}, ${i.summary}, ${i.severity}::smallint, ${i.lat}::float8, ${i.lon}::float8, ${country}::text, ${group}::text)`;
    }),
    sql`, `,
  );
  const updated = await getDb().execute(sql`
    update ${events} as e set
      title = v.title,
      summary = v.summary,
      severity = v.severity,
      lat = v.lat,
      lon = v.lon,
      country = coalesce(v.country, e.country),
      correlation_group_id = coalesce(v.grp, e.correlation_group_id),
      population_exposed = case when e.lat = v.lat and e.lon = v.lon then e.population_exposed end
    from (values ${values}) as v(url, title, summary, severity, lat, lon, country, grp)
    where e.url = v.url and e.source = 'gdacs'
      and (e.title, e.summary, e.severity, e.lat, e.lon, e.country)
        is distinct from (v.title, v.summary, v.severity, v.lat, v.lon, coalesce(v.country, e.country))
    returning e.id`);
  return updated.rows.length;
}

export interface GdacsConsolidation {
  events: number;
  rekeyed: number;
  superseded: number;
}

// One-time repair for the rows stored before 2026-09-29, one per episode.
// Per disaster, the row already on the per-event link is kept; failing
// that, the newest episode's row takes that link. Every other episode row
// is rejected with a reason naming the row that replaced it — not deleted,
// so the history stays inspectable and the change is reversible. Safe to
// re-run; a second run finds nothing to do. GDACS rows never train the
// gate model (gateStudent.ts reads RSS, GDELT and Telegram only), so these
// rejections are not labels.
export async function consolidateGdacsEpisodes(apply: boolean): Promise<GdacsConsolidation> {
  const db = getDb();
  const rows = await db
    .select({ id: events.id, url: events.url, reviewStatus: events.reviewStatus })
    .from(events)
    .where(and(eq(events.source, "gdacs"), like(events.url, "https://www.gdacs.org/report.aspx?%")));

  const byEvent = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = canonicalGdacsUrl(row.url);
    if (!key) continue;
    byEvent.set(key, [...(byEvent.get(key) ?? []), row]);
  }

  const result: GdacsConsolidation = { events: 0, rekeyed: 0, superseded: 0 };
  for (const [url, group] of byEvent) {
    const keeper = group.find((r) => r.url === url) ?? group.reduce((a, b) => (b.id > a.id ? b : a));
    const retire = group.filter((r) => r.id !== keeper.id && r.reviewStatus !== "rejected").map((r) => r.id);
    if (keeper.url === url && retire.length === 0) continue;
    result.events++;
    if (keeper.url !== url) result.rekeyed++;
    result.superseded += retire.length;
    if (!apply) continue;
    if (retire.length > 0) {
      await db
        .update(events)
        .set({
          reviewStatus: "rejected",
          reviewReasoning: `Superseded: an earlier GDACS episode of the disaster now tracked as event ${keeper.id} (${url}).`,
        })
        .where(inArray(events.id, retire));
    }
    if (keeper.url !== url) await db.update(events).set({ url }).where(eq(events.id, keeper.id));
  }
  return result;
}
