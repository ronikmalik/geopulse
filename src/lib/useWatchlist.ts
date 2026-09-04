"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "geopulse:watchlist";

function load(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

export function useWatchlist() {
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());

  useEffect(() => {
    // Deliberately not a `useState(load)` lazy initializer: SSR always
    // renders empty (no `window`), so the client's first render must also
    // start empty to match, then pick up localStorage here after mount —
    // reading it eagerly would cause a hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWatchlist(load());
  }, []);

  const persist = useCallback((next: Set<string>) => {
    setWatchlist(next);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
  }, []);

  const toggle = useCallback(
    (country: string) => {
      const next = new Set(watchlist);
      if (next.has(country)) next.delete(country);
      else next.add(country);
      persist(next);
    },
    [watchlist, persist],
  );

  return { watchlist, toggle };
}
