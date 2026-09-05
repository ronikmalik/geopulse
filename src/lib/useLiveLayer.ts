"use client";

import { useEffect, useState } from "react";

// Generic polling hook shared by every /api/layers/* data layer. Fetching
// only happens while `enabled` is true — flipping a layer off in the
// dashboard stops the poll loop entirely rather than fetching in the
// background forever.
export function useLiveLayer<T>(
  url: string,
  intervalMs: number,
  enabled: boolean,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
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
  }, [url, intervalMs, enabled]);

  return { data, error };
}
