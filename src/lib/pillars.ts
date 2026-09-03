import type { Category } from "./categories";

// The eight master risk pillars every country-level threat assessment rolls
// up from. This is GeoPulse's organizing structure for non-financial global
// risk — see docs/ROADMAP.md for the full blueprint this implements.
export const PILLAR_IDS = [
  "geopolitical-security",
  "political-governance",
  "climate-environment",
  "natural-biological-hazards",
  "human-social",
  "infrastructure-connectivity",
  "supply-chain-resource",
  "cyber-technology",
] as const;

export type PillarId = (typeof PILLAR_IDS)[number];

export interface PillarDef {
  id: PillarId;
  label: string;
  shortLabel: string;
  description: string;
  color: string;
}

export const PILLARS: Record<PillarId, PillarDef> = {
  "geopolitical-security": {
    id: "geopolitical-security",
    label: "Geopolitical & Security",
    shortLabel: "Security",
    description:
      "War, interstate tension, military activity, terrorism, political violence, piracy, sanctions, diplomatic confrontation.",
    color: "#ef4444",
  },
  "political-governance": {
    id: "political-governance",
    label: "Political & Governance",
    shortLabel: "Governance",
    description:
      "Government instability, coups, elections, protests, state capacity, corruption, rule of law, regulatory disruption.",
    color: "#f97316",
  },
  "climate-environment": {
    id: "climate-environment",
    label: "Climate & Environment",
    shortLabel: "Climate",
    description:
      "Extreme heat, drought, flooding, wildfire, water stress, pollution, climate anomalies, environmental degradation.",
    color: "#22c55e",
  },
  "natural-biological-hazards": {
    id: "natural-biological-hazards",
    label: "Natural & Biological Hazards",
    shortLabel: "Hazards",
    description:
      "Earthquakes, volcanoes, tsunamis, cyclones, outbreaks, industrial accidents, nuclear/radiological incidents.",
    color: "#eab308",
  },
  "human-social": {
    id: "human-social",
    label: "Human & Social",
    shortLabel: "Human & Social",
    description:
      "Food insecurity, refugees, displacement, civil unrest, public health, demographics, labor disruption, humanitarian crises.",
    color: "#a855f7",
  },
  "infrastructure-connectivity": {
    id: "infrastructure-connectivity",
    label: "Infrastructure & Connectivity",
    shortLabel: "Infrastructure",
    description:
      "Electricity, internet, telecom, ports, airports, rail, pipelines, roads, subsea cables, other critical infrastructure.",
    color: "#38bdf8",
  },
  "supply-chain-resource": {
    id: "supply-chain-resource",
    label: "Supply Chain & Resource Security",
    shortLabel: "Supply Chain",
    description:
      "Shipping, logistics, food, energy, water, critical minerals, agriculture, commodities, trade chokepoints.",
    color: "#f59e0b",
  },
  "cyber-technology": {
    id: "cyber-technology",
    label: "Cyber & Technology",
    shortLabel: "Cyber",
    description:
      "Cyberattacks, ransomware, critical vulnerabilities, infrastructure cyber incidents, cloud outages, technology dependencies.",
    color: "#818cf8",
  },
};

export const PILLAR_LIST: PillarDef[] = PILLAR_IDS.map((id) => PILLARS[id]);

// Not every pillar's events carry the same real-world consequence at the
// same reported severity — an active-war event and a routine-protest event
// can both get tagged severity 3 by the keyword classifier, but they are
// not equally dangerous. Without this, a country generating a high volume
// of ordinary political-governance coverage (heavily English-language-media
// countries especially) could out-rank a country with fewer but far more
// consequential geopolitical-security events. This multiplies each
// pillar's contribution to a country's decayed-weight total (see
// aggregateByCountryAndPillar in src/lib/risk.ts) — it does not touch
// per-event severity or momentum (a pctChange ratio, which is scale-
// invariant to a constant multiplier applied to both sides of it).
export const PILLAR_WEIGHT: Record<PillarId, number> = {
  "geopolitical-security": 1.5,
  "natural-biological-hazards": 1.3,
  "human-social": 1.1,
  "climate-environment": 1.0,
  "infrastructure-connectivity": 0.9,
  "supply-chain-resource": 1.0,
  "cyber-technology": 0.9,
  "political-governance": 0.75,
};

// Every event category maps to exactly one pillar. This is the single
// source of truth the risk model uses to roll category-level events up
// into pillar-level Threat Level + Momentum (see src/lib/risk.ts).
export const CATEGORY_PILLAR: Record<Category, PillarId> = {
  "us-iran": "geopolitical-security",
  "russia-ukraine": "geopolitical-security",
  "israel-palestine": "geopolitical-security",
  "china-taiwan": "geopolitical-security",
  "north-korea": "geopolitical-security",
  other: "geopolitical-security",
  "political-instability": "political-governance",
  humanitarian: "human-social",
  earthquake: "natural-biological-hazards",
  "natural-disaster": "natural-biological-hazards",
  "climate-hazard": "climate-environment",
  "infrastructure-outage": "infrastructure-connectivity",
};

export function pillarForCategory(category: Category): PillarId {
  return CATEGORY_PILLAR[category];
}

// Pillars with at least one live event source wired up in this build.
// Supply Chain & Resource Security and Cyber & Technology are modeled and
// shown in the UI, but have no country-attributable event source yet
// (CISA KEV, the one cyber source so far, is a global feed with no
// geolocation — see the "cyber" data layer) — surfacing them as "not yet
// tracked" is more honest than pretending a threat level for a pillar with
// zero signal. See docs/ROADMAP.md for the plan to close this gap.
export const COVERED_PILLARS = new Set<PillarId>([
  "geopolitical-security",
  "political-governance",
  "climate-environment",
  "natural-biological-hazards",
  "human-social",
  "infrastructure-connectivity",
]);
