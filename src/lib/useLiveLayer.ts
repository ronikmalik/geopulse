"use client";

import { useEffect, useState } from "react";
import { useTabVisible } from "./useTabVisible";

// Generic polling hook shared by every /api/layers/* data layer. Fetching
// only happens while `enabled` is true — flipping a layer off in the
// dashboard stops the poll loop entirely rather than fetching in the
// background forever. Also pauses while the tab is hidden (2026-09-09):
// a backgrounded tab has no business burning bandwidth/CPU on layers the
// user can't see, and re-running this effect the moment the tab becomes
// visible again means a fresh fetch happens right then instead of
// waiting for the browser's own throttled interval to next fire —
// sometimes stale by the layer's full intervalMs (up to 6h for some
// layers), sometimes several independently-throttled layers all firing
// in the same burst.
export function useLiveLayer<T>(
  url: string,
  intervalMs: number,
  enabled: boolean,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visible = useTabVisible();

  useEffect(() => {
    if (!enabled || !visible) return;
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status}`);
        const json = (await res.json()) as T;
        if (!cancelled) {
          setData(json);
          // Some /api/layers/* routes deliberately return HTTP 200 with an
          // empty result plus an `error` field on an upstream failure
          // (see commercial-flights route.ts) — an empty array alone can't
          // be told apart from a genuinely empty live reading, so surface
          // this the same way an HTTP-level failure would be.
          const bodyError = (json as { error?: unknown }).error;
          setError(typeof bodyError === "string" ? bodyError : null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };

    load();
    const id = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [url, intervalMs, enabled, visible]);

  return { data, error };
}
