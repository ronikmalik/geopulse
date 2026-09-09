"use client";

import { useEffect, useState } from "react";

// Shared by every polling hook (useLiveLayer, useCountryRisk,
// useAircraftAnomalies, usePulsingEvents) so each can skip its own work
// while the tab is hidden and catch up with exactly one fresh fetch/
// recompute the moment it becomes visible again, rather than relying on
// the browser's own background-tab timer throttling — inconsistent
// across browsers, and prone to several independently-throttled
// setInterval hooks all finally firing in the same burst right as a
// long-hidden tab regains focus (part of the 2026-09-09 "laggy when I
// switch back to the tab" fix, alongside useEventStream.ts's SSE
// message batching).
export function useTabVisible(): boolean {
  const [visible, setVisible] = useState(
    typeof document === "undefined" ? true : document.visibilityState === "visible",
  );

  useEffect(() => {
    const handler = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);

  return visible;
}
