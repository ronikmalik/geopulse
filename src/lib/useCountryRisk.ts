"use client";

import { useEffect, useState } from "react";
import type { ThreatLevel, MomentumDirection } from "@/lib/threat";
import { useTabVisible } from "./useTabVisible";

export interface CountryRiskScore {
  country: string;
  // Legacy decayed-weight total — drives the globe's heat-map color, which
  // is tuned against this exact continuous value (see Globe.tsx).
  score: number;
  eventCount: number;
  lastEventAt: string;
  threatLevel: ThreatLevel;
  threatLabel: string;
  momentum: number;
  momentumDirection: MomentumDirection;
}

const POLL_INTERVAL_MS = 60_000;

export function useCountryRisk() {
  const [scores, setScores] = useState<CountryRiskScore[]>([]);
  const visible = useTabVisible();

  // Paused while the tab is hidden (2026-09-09) — this poll also drives
  // Globe.tsx's refreshPolygons, a full country-polygon mesh rebuild, so
  // an update landing right as a long-hidden tab regains focus (the
  // browser's own throttled interval finally catching up) is exactly the
  // kind of visible stutter the user reported. Re-running this effect on
  // visibility return fetches once, immediately, instead of waiting on
  // that throttled timer.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/risk");
        const data = await res.json();
        if (!cancelled) setScores(data.scores ?? []);
      } catch {
        // keep last known scores on transient failure
      }
    };
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [visible]);

  return scores;
}
