"use client";

import { useEffect, useState } from "react";
import { useTabVisible } from "./useTabVisible";
import type { AnomalyFindingResponse } from "@/app/api/anomalies/route";

export type { AnomalyFindingResponse };

const POLL_INTERVAL_MS = 5 * 60_000;

// Same shape/posture as useAircraftAnomalies.ts, generalized to every
// signal type — a country can now have more than one finding at once
// (e.g. both a GPS-jamming spike and an event-volume spike), hence a Map
// of arrays rather than a Map of single values.
export function useAnomalies(): Map<string, AnomalyFindingResponse[]> {
  const [byCountry, setByCountry] = useState<Map<string, AnomalyFindingResponse[]>>(new Map());
  const visible = useTabVisible();

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/anomalies");
        const data = await res.json();
        if (cancelled) return;
        const grouped = new Map<string, AnomalyFindingResponse[]>();
        for (const finding of (data.findings ?? []) as AnomalyFindingResponse[]) {
          const list = grouped.get(finding.country) ?? [];
          list.push(finding);
          grouped.set(finding.country, list);
        }
        setByCountry(grouped);
      } catch {
        // keep last known findings on transient failure
      }
    };
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [visible]);

  return byCountry;
}
