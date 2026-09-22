"use client";

import { useEffect, useState } from "react";
import { useTabVisible } from "./useTabVisible";
import type { AlertView } from "@/lib/alertEngine";

export type { AlertView };

// Same posture as useAnomalies: poll, keep the last good answer on a
// transient failure, and stop entirely while the tab is hidden.
//
// Five minutes matches the route's own CDN cache. Alerts are written by
// the review job once per pipeline cycle (~30 min), so polling faster
// would re-serve the same cached response and buy nothing — and every
// avoided request is a database wake-up this project does not spend
// (docs/ARCHITECTURE.md §12).
const POLL_INTERVAL_MS = 5 * 60_000;

export function useAlerts(): { alerts: AlertView[]; loading: boolean } {
  const [alerts, setAlerts] = useState<AlertView[]>([]);
  const [loading, setLoading] = useState(true);
  const visible = useTabVisible();

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/alerts");
        const data = await res.json();
        if (cancelled) return;
        setAlerts((data.alerts ?? []) as AlertView[]);
      } catch {
        // keep the last known alerts on a transient failure
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [visible]);

  return { alerts, loading };
}
