import { and, desc, eq, isNull, or, like } from "drizzle-orm";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { resolveLocationsBatch, GEOCODE_BATCH_SIZE, type GeocodeCandidate } from "./geocodeEvents";
import { canAffordGeminiLiteCall, recordAiUsage } from "./aiUsage";

// Decoupled backfill pass — same posture as embeddingBackfill.ts: never
// block the insert path (ingest.ts inserts every event with
// classify.ts's country-centroid lat/lon immediately, unchanged), then
// this catches up after the fact on its own short deadline (see the call
// site in ingest.ts's runGeminiAuditChain).
//
// Scoped to source LIKE 'rss:%' OR 'telegram:%' — a 2026-09-09 user
// decision. Those two both run through classify.ts's classifyByKeywords,
// the path with no location-extraction step (see geocodeEvents.ts's doc
// comment) — GDELT (a separate classifyGdeltItem path) and the direct/
// structural sources (USGS/EONET/GDACS/IODA/FIRMS, which already carry
// real event-level coordinates from their own APIs) are deliberately left
// alone; their rows' geocodedAt simply stays NULL forever, which is
// harmless since nothing else reads that column.
const SOURCE_SCOPE = or(like(events.source, "rss:%"), like(events.source, "telegram:%"));

export interface GeocodeBackfillResult {
  processed: number;
  skipped: boolean;
}

export async function backfillEventGeocodes(): Promise<GeocodeBackfillResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { processed: 0, skipped: true };

  // Daily cap check (see aiUsage.ts's GEMINI_LITE_DAILY_CAPS) — this used
  // to run uncapped, once per ~15min ingest cycle (up to 96 calls/day),
  // the one gemini-3.5-flash-lite caller left untouched by the earlier
  // audit-priority rebalance. Checked before the DB query too, not just
  // before the Gemini call, so a day at cap doesn't even pay for the
  // query — same "ask first" posture as translationUsage.ts.
  if (!(await canAffordGeminiLiteCall("geocode"))) {
    return { processed: 0, skipped: true };
  }

  try {
    const db = getDb();
    const rows = await db
      .select({
        id: events.id,
        title: events.title,
        summary: events.summary,
        country: events.country,
      })
      .from(events)
      .where(and(isNull(events.geocodedAt), SOURCE_SCOPE))
      .orderBy(desc(events.id))
      .limit(GEOCODE_BATCH_SIZE);

    if (rows.length === 0) return { processed: 0, skipped: false };

    const candidates: GeocodeCandidate[] = rows
      .filter((r): r is typeof r & { country: string } => r.country !== null)
      .map((r) => ({ id: r.id, title: r.title, snippet: r.summary, country: r.country }));

    const resolved = await resolveLocationsBatch(candidates, apiKey);
    // resolveLocationsBatch no-ops (no real call) when candidates is
    // empty — only record spend when a call could actually have happened.
    if (candidates.length > 0) await recordAiUsage("geocode", 1);

    // The whole call failed (network/timeout/parse error) — leave every
    // row's geocodedAt untouched so this exact backlog is retried next
    // cycle, rather than permanently giving up on it. Same distinction
    // classifierAudit.ts's markAudited draws by only being called after
    // a real Gemini response.
    if (resolved === null) return { processed: 0, skipped: true };

    let processed = 0;
    for (const row of rows) {
      const result = resolved.get(row.id);
      if (result) {
        await db
          .update(events)
          .set({ location: result.location, lat: result.lat, lon: result.lon, geocodedAt: new Date() })
          .where(eq(events.id, row.id));
        processed++;
      } else {
        // The call succeeded but this specific row either wasn't a
        // resolvable country (filtered out above) or Gemini's answer for
        // it failed validation — stamp geocodedAt anyway so it isn't
        // re-fetched every cycle forever; it keeps its existing
        // country-centroid coordinate, same as before this pass existed.
        await db.update(events).set({ geocodedAt: new Date() }).where(eq(events.id, row.id));
      }
    }
    return { processed, skipped: false };
  } catch (err) {
    console.error(`backfillEventGeocodes failed: ${err}`);
    return { processed: 0, skipped: true };
  }
}
