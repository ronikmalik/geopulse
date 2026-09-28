import { NextResponse } from "next/server";
import { and, desc, eq, gte, like } from "drizzle-orm";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { NOT_KILL_SWITCHED } from "@/lib/killSwitch";
import { sourceLabel } from "@/lib/sourceLabels";
import { splitAttribution } from "@/lib/displayText";
import { cachedJson } from "@/lib/apiParams";
import type { TelegramLayerPost } from "@/lib/dataLayerTypes";

// Reads the Telegram posts ingestion already stored and review approved
// (2026-09-28). This route used to call fetchTelegramChannel for every
// channel on a cache miss, which is ingestion itself: it spent the
// translation budget on page views and wrote every post to
// classification_archive, after which the scheduled ingest skipped those
// URLs as already seen. A viewer opening this layer could therefore stop
// posts from ever reaching the feed. Reading stored rows costs one indexed
// query, shows only what passed the review gate, and never touches
// Telegram, the translation API or the archive.
const WINDOW_HOURS = 48;
const LIMIT = 40;

export async function GET() {
  try {
    const db = getDb();
    const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60_000);
    const rows = await db
      .select({
        source: events.source,
        country: events.country,
        url: events.url,
        summary: events.summary,
        publishedAt: events.publishedAt,
      })
      .from(events)
      .where(
        and(
          like(events.source, "telegram:%"),
          eq(events.reviewStatus, "approved"),
          NOT_KILL_SWITCHED,
          gte(events.publishedAt, since),
        ),
      )
      .orderBy(desc(events.publishedAt))
      .limit(LIMIT);

    const posts: TelegramLayerPost[] = rows.map((r) => {
      const { body, translatedFrom } = splitAttribution(r.summary, r.source);
      return {
        channelLabel: sourceLabel(r.source),
        country: r.country ?? "",
        url: r.url,
        text: body,
        translated: translatedFrom !== null,
        publishedAt: r.publishedAt.toISOString(),
      };
    });
    return cachedJson({ posts }, 300);
  } catch (err) {
    console.error(`layer:telegram failed: ${err}`);
    return NextResponse.json({ posts: [], error: "Telegram posts unavailable" });
  }
}
