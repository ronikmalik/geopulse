import { NextResponse } from "next/server";
import { fetchTelegramChannel, TELEGRAM_CHANNELS } from "@/lib/sources/telegram";
import { withCache } from "@/lib/layerCache";
import type { TelegramLayerPost } from "@/lib/dataLayerTypes";

// Unlike the ingest.ts rotation (which spreads the 9 channels across
// several cron cycles to keep request volume down — see
// docs/TELEGRAM_SOURCES.md), this route is user-triggered by opening the
// Layers panel, not an unattended cron, so it fetches every channel in
// one go. Still sequential with spacing rather than a burst of 9
// concurrent requests, and cached for the same 5 minutes as the poll
// interval so re-opening the panel doesn't re-fetch on every mount.
export const maxDuration = 30;

const CACHE_TTL_MS = 5 * 60_000;
const QUERY_SPACING_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// telegram.ts's DirectItem.summary is "<label>[ [translated from X]]:
// <excerpt>" — deliberate for the events table (every stored event stays
// self-describing even out of context, see docs/TELEGRAM_SOURCES.md
// "Framing discipline"). This layer's UI already shows channelLabel as
// its own field, so stripping the known, controlled prefix back off here
// avoids showing it twice. Safe because this route owns both sides of
// the format (same package, same author).
function stripLabelPrefix(summary: string, label: string): string {
  const prefix = new RegExp(`^${escapeRegExp(label)}( \\[translated from [^\\]]+\\])?: `);
  return summary.replace(prefix, "");
}

export async function GET() {
  const posts = await withCache("layer:telegram", CACHE_TTL_MS, async () => {
    const all: TelegramLayerPost[] = [];
    for (let i = 0; i < TELEGRAM_CHANNELS.length; i++) {
      if (i > 0) await sleep(QUERY_SPACING_MS);
      const config = TELEGRAM_CHANNELS[i];
      try {
        const items = await fetchTelegramChannel(config);
        for (const item of items) {
          all.push({
            channelLabel: config.label,
            country: config.country,
            url: item.url,
            text: stripLabelPrefix(item.summary, config.label),
            translated: item.summary.includes("[translated from"),
            publishedAt: item.publishedAt.toISOString(),
          });
        }
      } catch (err) {
        console.error(`Telegram layer fetch failed for ${config.handle}: ${err}`);
      }
    }
    all.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
    return all;
  });

  return NextResponse.json({ posts });
}
