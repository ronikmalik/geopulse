// Selectable "live data" layers — distinct from the event Category system
// (src/lib/categories.ts). These aren't geopolitical events stored in
// Postgres; they're live external data fetched on demand through
// src/app/api/layers/*/route.ts and rendered either as points on the globe
// or as an inline ticker in the Data Layers dashboard.
export const GLOBE_DATA_LAYERS = [
  "flights",
  "commercial-flights",
  "weather",
] as const;
export const TICKER_DATA_LAYERS = [
  "satellites",
  "crypto",
  "github",
  "gdp",
  "population",
  "macro",
  "cyber",
] as const;

export const DATA_LAYERS = [...GLOBE_DATA_LAYERS, ...TICKER_DATA_LAYERS] as const;

export type GlobeDataLayerId = (typeof GLOBE_DATA_LAYERS)[number];
export type TickerDataLayerId = (typeof TICKER_DATA_LAYERS)[number];
export type DataLayerId = (typeof DATA_LAYERS)[number];

export function isGlobeDataLayer(id: DataLayerId): id is GlobeDataLayerId {
  return (GLOBE_DATA_LAYERS as readonly string[]).includes(id);
}

export const DATA_LAYER_LABELS: Record<DataLayerId, string> = {
  flights: "Live Military Flights",
  "commercial-flights": "Commercial Air Traffic",
  weather: "Weather Conditions",
  satellites: "Tracked Satellites",
  crypto: "Crypto Markets",
  github: "GitHub Trending",
  gdp: "Top Economies (GDP)",
  population: "Population Ranking",
  macro: "Macro Indicators",
  cyber: "Actively Exploited Vulnerabilities",
};

export const DATA_LAYER_DESCRIPTIONS: Record<DataLayerId, string> = {
  flights: "adsb.lol — live-tracked military aircraft, plotted on the globe.",
  "commercial-flights":
    "OpenSky Network — live commercial air traffic over Europe/Middle East.",
  weather: "Open-Meteo — current conditions at 12 monitored capitals.",
  satellites: "CelesTrak — actively tracked satellites and orbital period.",
  crypto: "CoinGecko — top cryptocurrencies by market cap.",
  github: "GitHub — highest-starred repos pushed in the last 7 days.",
  gdp: "World Bank — countries ranked by GDP (current US$).",
  population: "World Bank — most populous countries.",
  macro: "ECB EUR/USD, BIS US policy rate, Eurostat EU unemployment.",
  cyber: "CISA KEV — vulnerabilities with confirmed active exploitation, most recent first.",
};

// Poll intervals per layer — long enough to respect free-tier rate limits
// (CoinGecko/GitHub especially), short enough to feel "live" for the
// fast-moving ones.
export const DATA_LAYER_POLL_MS: Record<DataLayerId, number> = {
  flights: 20_000,
  "commercial-flights": 20_000,
  weather: 5 * 60_000,
  satellites: 5 * 60_000,
  crypto: 60_000,
  github: 10 * 60_000,
  gdp: 60 * 60_000,
  population: 60 * 60_000,
  macro: 15 * 60_000,
  cyber: 30 * 60_000,
};
