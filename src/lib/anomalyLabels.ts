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
    default:
      return signalType;
  }
}

export function signalDescription(f: AnomalyFindingResponse): string {
  const name =
    f.signalType === "event-volume-category" && f.category
      ? `${CATEGORY_LABELS[f.category as Category] ?? f.category} news volume`
      : signalName(f.signalType);
  const direction = f.jump >= 0 ? "up" : "down";
  return `${name} ${direction} to ${f.observedValue} vs. a ${f.baselineMean} average over the last ${f.sampleSize} days (z=${f.zScore})`;
}
