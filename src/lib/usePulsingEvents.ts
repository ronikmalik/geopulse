"use client";

import { useEffect, useState } from "react";
import type { GeoEvent } from "@/lib/types";

// User request (2026-09-05): "I want the pulses to ripple." The old design
// only rippled an event for 60 seconds right when it happened to stream in
// live during the current browser tab's session (usePulsingEvents used to
// take `incoming`, useEventStream's live-delivery-only queue) — so a page
// freshly loaded with a 20-minute-old backfilled item sat completely
// static, and most events most users ever saw never rippled at all.
//
// Now derived from the event's own real-world age instead: any event still
// within RECENT_WINDOW_MS of its publishedAt ripples on an ongoing loop
// (globe.gl's ringsData repeats automatically — see Globe.tsx), regardless
// of whether it arrived via live SSE or the initial backfill. Recomputed
// on an interval rather than only when `events` changes, since "is this
// still recent" is a moving target purely from the passage of time.
const RECENT_WINDOW_MS = 3 * 60 * 60_000; // 3 hours
const RECHECK_INTERVAL_MS = 30_000;

export function usePulsingEvents(events: GeoEvent[]): Set<number> {
  const [pulsingIds, setPulsingIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    function recompute() {
      const now = Date.now();
      const next = new Set<number>();
      for (const e of events) {
        // publishedAt travels over JSON (SSE/fetch) as a plain string
        // despite GeoEvent's Date-typed field — same treatment FeedPanel/
        // CountryRiskPanel already give it.
        const publishedAt = new Date(
          e.publishedAt as unknown as string,
        ).getTime();
        if (!Number.isNaN(publishedAt) && now - publishedAt < RECENT_WINDOW_MS) {
          next.add(e.id);
        }
      }
      setPulsingIds(next);
    }

    recompute();
    const interval = setInterval(recompute, RECHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [events]);

  return pulsingIds;
}
