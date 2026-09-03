// Selectable "live data" layers — distinct from the event Category system
// (src/lib/categories.ts). These aren't geopolitical events stored in
// Postgres; they're live external data fetched on demand through
// src/app/api/layers/*/route.ts and rendered either as points on the globe
// or as an inline ticker in the Data Layers dashboard.
//
// Every layer here is chosen because it feeds one of the eight risk
// pillars or adds structural country context (see src/lib/pillars.ts) —
// this is an OSINT risk-intelligence platform, not a general-purpose
// dashboard. Crypto markets, trending GitHub repos, and generic satellite
// tracking were removed for exactly that reason: none of them fed a
// pillar or told an analyst anything about risk.
export const GLOBE_DATA_LAYERS = [
  "flights",
  "commercial-flights",
  "weather",
] as const;
export const TICKER_DATA_LAYERS = ["gdp", "population", "cyber"] as const;

export const DATA_LAYERS = [...GLOBE_DATA_LAYERS, ...TICKER_DATA_LAYERS] as const;

export type GlobeDataLayerId = (typeof GLOBE_DATA_LAYERS)[number];
export type TickerDataLayerId = (typeof TICKER_DATA_LAYERS)[number];
export type DataLayerId = (typeof DATA_LAYERS)[number];

export function isGlobeDataLayer(id: DataLayerId): id is GlobeDataLayerId {
  return (GLOBE_DATA_LAYERS as readonly string[]).includes(id);
}

export const DATA_LAYER_LABELS: Record<DataLayerId, string> = {
  flights: "Military Aircraft Activity",
  "commercial-flights": "Commercial Air Traffic",
  weather: "Weather Conditions",
  gdp: "Economic Exposure (GDP)",
  population: "Population Exposure",
  cyber: "Actively Exploited Vulnerabilities",
};

export const DATA_LAYER_DESCRIPTIONS: Record<DataLayerId, string> = {
  flights:
    "adsb.lol — live-tracked military aircraft. Unusual concentrations or airspace activity are a Geopolitical & Security signal.",
  "commercial-flights":
    "OpenSky Network — live commercial air traffic over Europe/Middle East. A sharp drop can indicate an airspace closure or disruption.",
  weather: "Open-Meteo — current conditions at 12 monitored capitals, for Climate & Environment context.",
  gdp: "World Bank — GDP by country. Structural context for how much economic exposure a threat in that country represents.",
  population: "World Bank — population by country. Structural context for how many people a threat in that country could affect.",
  cyber: "CISA KEV — vulnerabilities with confirmed active exploitation, most recent first. Global feed (no country attribution yet) for the Cyber & Technology pillar.",
};

// Poll intervals per layer — long enough to respect free-tier rate limits,
// short enough to feel "live" for the fast-moving ones.
export const DATA_LAYER_POLL_MS: Record<DataLayerId, number> = {
  flights: 20_000,
  "commercial-flights": 20_000,
  weather: 5 * 60_000,
  gdp: 60 * 60_000,
  population: 60 * 60_000,
  cyber: 30 * 60_000,
};
