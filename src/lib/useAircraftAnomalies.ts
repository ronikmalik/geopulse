"use client";

import { useEffect, useState } from "react";
import { useTabVisible } from "./useTabVisible";

export interface AircraftAnomaly {
  country: string;
  todayCount: number;
  baselineMean: number;
  baselineStdDev: number;
  sampleSize: number;
  zScore: number;
}

// Much longer poll than useCountryRisk's 60s — this is a once-a-day
// computed signal (see the daily snapshot-flights cron in vercel.ts), not
// a live one, so there's nothing new to find on a fast poll.
const POLL_INTERVAL_MS = 5 * 60_000;

export function useAircraftAnomalies(): Map<string, AircraftAnomaly> {
  const [anomalies, setAnomalies] = useState<Map<string, AircraftAnomaly>>(new Map());
  const visible = useTabVisible();

  // Paused while the tab is hidden (2026-09-09) — same posture as every
  // other polling hook now (useLiveLayer, useCountryRisk): no reason to
  // keep fetching a signal the user can't see, and re-running on
  // visibility return gets a fresh read immediately rather than waiting
  // out this already-long 5-minute interval.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/aircraft-anomalies");
        const data = await res.json();
        if (!cancelled) {
          setAnomalies(
            new Map((data.anomalies ?? []).map((a: AircraftAnomaly) => [a.country, a])),
          );
        }
      } catch {
        // keep last known anomalies on transient failure
      }
    };
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [visible]);

  return anomalies;
}
