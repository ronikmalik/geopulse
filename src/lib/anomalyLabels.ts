import { CATEGORY_LABELS, type Category } from "@/lib/categories";
import type { AnomalyFindingResponse } from "@/lib/useAnomalies";

// Shared between CountryRiskPanel.tsx and TrendsPanel.tsx — both render
// the same anomaly_findings shape and should describe a finding the same
// way, not two independently-drifting copies of this text.
export function signalName(signalType: string): string {
  switch (signalType) {
    case "aircraft-military":
      return "military aircraft activity";
    case "aircraft-commercial":
      return "commercial air traffic";
    case "gps-jamming":
      return "GPS/GNSS jamming";
    case "event-volume":
      return "news volume";
    case "event-volume-category":
      return "category news volume";
    case "narrative-novelty":
      return "share of coverage matching no known narrative (%)";
    case "chokepoint-transit":
      return "maritime chokepoint transits";
    default:
      return signalType;
  }
}

export function signalDescription(f: AnomalyFindingResponse): string {
  // `category` carries a different thing per signal: an event category for
  // event-volume-category, the chokepoint's name for chokepoint-transit.
  const name =
    f.signalType === "event-volume-category" && f.category
      ? `${CATEGORY_LABELS[f.category as Category] ?? f.category} news volume`
      : f.signalType === "chokepoint-transit" && f.category
        ? `${f.category} vessel transits`
        : signalName(f.signalType);
  const direction = f.jump >= 0 ? "up" : "down";
  return `${name} ${direction} to ${f.observedValue} vs. a ${f.baselineMean} average over the last ${f.sampleSize} days (z=${f.zScore})`;
}
