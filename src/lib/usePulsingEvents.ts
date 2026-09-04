"use client";

import { useEffect, useRef, useState } from "react";
import type { GeoEvent } from "@/lib/types";

// How long a freshly-arrived event keeps pulsing on the globe before
// settling into a plain static marker — long enough to actually notice,
// short enough that the globe doesn't accumulate a permanent wall of rings
// over a long-running session.
const PULSE_DURATION_MS = 60_000;
const PRUNE_INTERVAL_MS = 5_000;

// Tracks which event ids should currently render a pulsing ring on the
// globe: every event the live SSE stream delivers in real time (`incoming`
// from useEventStream) pulses once, for PULSE_DURATION_MS, then stops —
// distinct from the full backfilled `events` list, which shouldn't all
// light up at once just because the page loaded.
//
// seenRef is permanent (never pruned) specifically so a since-expired id
// can't get its pulse revived — `incoming` only grows over a session (it's
// a dismissable toast queue, not deduped against past state the way
// `events` is), so without this guard, re-scanning the full array on every
// change would re-schedule already-expired events indefinitely.
export function usePulsingEvents(incoming: GeoEvent[]): Set<number> {
  const seenRef = useRef<Set<number>>(new Set());
  const expiryRef = useRef<Map<number, number>>(new Map());
  const [pulsingIds, setPulsingIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    const now = Date.now();
    let added = false;
    for (const e of incoming) {
      if (!seenRef.current.has(e.id)) {
        seenRef.current.add(e.id);
        expiryRef.current.set(e.id, now + PULSE_DURATION_MS);
        added = true;
      }
    }
    if (added) setPulsingIds(new Set(expiryRef.current.keys()));
  }, [incoming]);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, expiry] of expiryRef.current) {
        if (expiry <= now) {
          expiryRef.current.delete(id);
          changed = true;
        }
      }
      if (changed) setPulsingIds(new Set(expiryRef.current.keys()));
    }, PRUNE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  return pulsingIds;
}
