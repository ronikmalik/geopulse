"use client";

import { useEffect, useState } from "react";
import type { ThreatLevel, MomentumDirection } from "@/lib/threat";

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

  useEffect(() => {
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
  }, []);

  return scores;
}
