import { pillarForCategory } from "./pillars";
import type { Category } from "./categories";

// Event correlation, v1. The brief's suggested clustering factors are
// geographic proximity, time proximity, semantic similarity, event-type
// compatibility, and independent-source confirmation. This implements the
// first four as one deterministic key — no ML, no similarity scoring, no
// separate clustering pass to run and keep in sync — computed the same way
// at ingest time for every source:
//
//   correlation_group_id = "<country>:<pillar>:<UTC day>"
//
// Two events land in the same group when they're about the same country,
// the same risk pillar, on the same UTC calendar day. That's coarser than
// true semantic clustering (it can't tell a cyclone from a port strike if
// both hit the same country's Infrastructure pillar on the same day, and a
// story spanning midnight UTC splits across two groups) but it's honest
// about what it is, costs nothing to compute, and is strictly better than
// no correlation at all: it's what src/lib/risk.ts uses to compute a
// confidence tier from source diversity per cluster (see
// getCountryRiskEvents), and what a future v2 (real semantic/geographic
// clustering, a dedicated event_clusters table) would replace wholesale
// rather than extend.
export function correlationGroupId(
  country: string,
  category: Category,
  publishedAt: Date,
): string {
  const pillar = pillarForCategory(category);
  const dayBucket = publishedAt.toISOString().slice(0, 10);
  return `${country.toUpperCase()}:${pillar}:${dayBucket}`;
}

export type ConfidenceTier = "single-source" | "corroborated" | "cross-confirmed";

// Media-derived sources (news wires, text-classified) vs. direct/sensor
// sources (a seismograph network, a satellite, an internet-measurement
// platform) — matching the brief's Tier A/B/C reliability framing loosely:
// agreement WITHIN one type is weaker evidence than agreement ACROSS types,
// because every GDELT hit and every RSS wire is ultimately reporting on
// the same underlying reality through the same lens (the news cycle),
// while USGS/GDACS/EONET/IODA observe independently of what anyone wrote.
function sourceKind(source: string): "media" | "direct" {
  return source === "gdelt" || source.startsWith("rss:") ? "media" : "direct";
}

// A simple, configurable evidence ladder rather than a hardcoded
// probability: one source (however many times duplicated by the same
// outlet type) is the weakest tier; multiple distinct sources of the same
// kind is stronger; multiple distinct sources spanning both media and
// direct/sensor evidence is the strongest tier this model expresses.
export function classifyConfidence(sources: string[]): ConfidenceTier {
  const distinct = new Set(sources);
  if (distinct.size <= 1) return "single-source";
  const kinds = new Set([...distinct].map(sourceKind));
  return kinds.size > 1 ? "cross-confirmed" : "corroborated";
}

export const CONFIDENCE_LABELS: Record<ConfidenceTier, string> = {
  "single-source": "Single source",
  corroborated: "Corroborated",
  "cross-confirmed": "Cross-confirmed",
};
