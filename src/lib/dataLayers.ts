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
export const TICKER_DATA_LAYERS = [
  "gdp",
  "population",
  "cyber",
  "telegram",
  "gps-jamming",
  "submarine-cables",
  "travel-advisories",
  "grid-loss",
  "energy-mix",
  "food-price-index",
  "air-quality",
  "port-congestion",
  "trade-balance",
] as const;

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
  telegram: "Telegram OSINT (breaking incidents)",
  "gps-jamming": "GPS/GNSS Jamming",
  "submarine-cables": "Submarine Cable Exposure",
  "travel-advisories": "US Travel Advisories",
  "grid-loss": "Power Grid Losses",
  "energy-mix": "Energy Mix Exposure",
  "food-price-index": "Food Price Index",
  "air-quality": "Air Quality (PM2.5)",
  "port-congestion": "Maritime Chokepoint Traffic",
  "trade-balance": "Trade Partner Exposure",
};

export const DATA_LAYER_DESCRIPTIONS: Record<DataLayerId, string> = {
  flights:
    "adsb.lol — live-tracked military aircraft. Unusual concentrations or airspace activity are a Geopolitical & Security signal.",
  "commercial-flights":
    "adsb.lol — live commercial air traffic over several geopolitically dense hubs (Europe, Gulf, Levant, Russia, US East Coast, East Asia). A sharp drop can indicate an airspace closure or disruption.",
  weather: "Open-Meteo — current conditions at 12 monitored capitals, for Climate & Environment context.",
  gdp: "World Bank — GDP by country. Structural context for how much economic exposure a threat in that country represents.",
  population: "World Bank — population by country. Structural context for how many people a threat in that country could affect.",
  cyber: "CISA KEV — vulnerabilities with confirmed active exploitation, most recent first. Global feed (no country attribution yet) for the Cyber & Technology pillar.",
  telegram: "The same 9 Telegram channels feeding scored events, filtered to breaking incidents only (not a raw channel firehose) — shown here with full channel attribution as context rather than mapped/scored. See docs/TELEGRAM_SOURCES.md for the filter and the terms-of-service tradeoff this source involves.",
  "gps-jamming":
    "gpsjam.org — aircraft-derived GPS/GNSS interference, attributed to the nearest country/coastline. Jamming clusters concentrate near contested straits and active conflict zones, a Geopolitical & Security signal.",
  "submarine-cables":
    "TeleGeography — submarine cable landing points per country. Fewer landings means less redundancy against a single cable cut, Infrastructure & Connectivity context (static registry, not a live fault feed).",
  "travel-advisories":
    "US State Department — official Level 1-4 travel risk per country, Political & Governance context.",
  "grid-loss":
    "World Bank — electric power transmission & distribution losses (% of output). Chronic grid loss tracks infrastructure decay, Infrastructure & Connectivity context.",
  "energy-mix":
    "Our World in Data — fossil-fuel share of electricity generation by country. Structural context for energy-supply exposure.",
  "food-price-index":
    "FAO — global monthly Food Price Index. Food price spikes are a well-established driver of political instability (see the 2007-08 and 2010-11 spikes preceding the Arab Spring).",
  "air-quality":
    "Open-Meteo — model-estimated PM2.5 at the same 12 monitored capitals as Weather. Environmental context only, not fed into the risk model.",
  "port-congestion":
    "IMF PortWatch — daily vessel transits through the world's 28 major maritime chokepoints, Infrastructure & Connectivity / Supply Chain context.",
  "trade-balance":
    "UN Comtrade — top export partners for a curated set of geopolitically significant economies. Structural trade-exposure context.",
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
  // Same 5-minute floor as weather — frequent enough to feel live without
  // adding meaningfully to the request volume concern documented in
  // docs/TELEGRAM_SOURCES.md (this layer's own route also caches).
  telegram: 5 * 60_000,
  // Matched to each route's own withCache TTL (see the route files) —
  // polling faster than the server-side cache refreshes would just be
  // wasted requests re-serving the same cached response.
  "gps-jamming": 60 * 60_000,
  "submarine-cables": 6 * 60 * 60_000,
  "travel-advisories": 6 * 60 * 60_000,
  "grid-loss": 60 * 60_000,
  "energy-mix": 60 * 60_000,
  "food-price-index": 60 * 60_000,
  "air-quality": 30 * 60_000,
  "port-congestion": 6 * 60 * 60_000,
  "trade-balance": 24 * 60 * 60_000,
};
