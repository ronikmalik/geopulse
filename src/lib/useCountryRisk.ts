"use client";

import { useEffect, useRef, useState } from "react";
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

// The summary regenerates only when the pipeline purges it (every 15-30
// min); a 60s poll was 15-30 identical requests per change (2026-09-28).
const POLL_INTERVAL_MS = 5 * 60_000;

export function useCountryRisk() {
  const [scores, setScores] = useState<CountryRiskScore[]>([]);
  const visible = useTabVisible();
  // The route is CDN-cached for longer than this poll, so most polls return
  // the same body; an unchanged one must not trigger a full polygon rebuild.
  const lastBodyRef = useRef<string | null>(null);

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
        const res = await fetch("/api/risk/summary");
        if (!res.ok) return; // An error payload must not erase the globe's last known scores.
        const body = await res.text();
        if (cancelled || body === lastBodyRef.current) return;
        const data = JSON.parse(body);
        if (Array.isArray(data.scores)) {
          lastBodyRef.current = body;
          setScores(data.scores);
        }
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
