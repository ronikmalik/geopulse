// Selectable "live data" layers - distinct from the event Category system
// (src/lib/categories.ts). These aren't geopolitical events stored in
// Postgres; they're live external data fetched on demand through
// src/app/api/layers/*/route.ts and rendered as points on the globe
// and/or as an inline preview in the Layers panel.
//
// Every layer here is chosen because it feeds one of the eight risk
// pillars or adds structural country context (see src/lib/pillars.ts) -
// this is an OSINT risk-intelligence platform, not a general-purpose
// dashboard. Crypto markets, trending GitHub repos, and generic satellite
// tracking were removed for exactly that reason: none of them fed a
// pillar or told an analyst anything about risk.
export const DATA_LAYERS = [
  "flights",
  "commercial-flights",
  "weather",
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
  "major-ports",
  "trade-balance",
  "sanctions",
  "internet-censorship",
] as const;

export type DataLayerId = (typeof DATA_LAYERS)[number];

// Layers that plot points on the globe when switched on (see page.tsx's
// extraPoints); the rest show only their preview in the Layers panel.
// Replaces the old GLOBE_/TICKER_ split (2026-09-28), which had drifted:
// nine "ticker" layers had long since gained map points.
export const MAPPED_DATA_LAYERS: ReadonlySet<DataLayerId> = new Set<DataLayerId>([
  "flights",
  "commercial-flights",
  "weather",
  "cyber",
  "gps-jamming",
  "submarine-cables",
  "travel-advisories",
  "grid-loss",
  "energy-mix",
  "air-quality",
  "port-congestion",
  "major-ports",
  "trade-balance",
  "internet-censorship",
]);

// How the Layers panel groups the context layers (2026-09-28: nineteen
// in one list had become hard to scan). Every layer appears in exactly one
// group; scripts/new-sources.test.ts checks that.
export const DATA_LAYER_GROUPS: { label: string; layers: DataLayerId[] }[] = [
  { label: "Security & conflict", layers: ["flights", "gps-jamming", "telegram", "travel-advisories", "sanctions"] },
  { label: "Connectivity & cyber", layers: ["internet-censorship", "submarine-cables", "cyber"] },
  { label: "Transport & trade", layers: ["commercial-flights", "port-congestion", "major-ports", "trade-balance"] },
  { label: "Economy & resources", layers: ["gdp", "population", "food-price-index", "energy-mix", "grid-loss"] },
  { label: "Environment", layers: ["weather", "air-quality"] },
];

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
  sanctions: "Sanctions Designations",
  "port-congestion": "Maritime Chokepoint Traffic",
  "major-ports": "Major Seaports",
  "trade-balance": "Trade Partner Exposure",
  "internet-censorship": "Website Blocking (OONI)",
};

export const DATA_LAYER_DESCRIPTIONS: Record<DataLayerId, string> = {
  flights:
    "adsb.lol - live-tracked military aircraft. Unusual concentrations or airspace activity are a Geopolitical & Security signal.",
  "commercial-flights":
    "adsb.lol - live commercial air traffic over several geopolitically dense hubs (Europe, Gulf, Levant, Russia, US East Coast, East Asia). A sharp drop can indicate an airspace closure or disruption.",
  weather: "Open-Meteo - current conditions at 12 monitored capitals, for Climate & Environment context.",
  gdp: "World Bank - GDP by country. Structural context for how much economic exposure a threat in that country represents.",
  population: "World Bank - population by country. Structural context for how many people a threat in that country could affect.",
  cyber: "CISA KEV - vulnerabilities with confirmed active exploitation, most recent first, for the Cyber & Technology pillar. Plotted at the vendor's headquarters: a proxy, not where the exploitation happened.",
  telegram: "The latest reviewed incidents from the 12 named Telegram channels (official accounts and clearly labelled partisan ones), with full channel attribution. The same posts also appear in the feed.",
  "gps-jamming":
    "gpsjam.org - aircraft-derived GPS/GNSS interference, attributed to the nearest country/coastline. Jamming clusters concentrate near contested straits and active conflict zones, a Geopolitical & Security signal.",
  "submarine-cables":
    "TeleGeography - submarine cable landing points per country. Fewer landings means less redundancy against a single cable cut, Infrastructure & Connectivity context (static registry, not a live fault feed).",
  "travel-advisories":
    "US State Department - official Level 1-4 travel risk per country, Political & Governance context.",
  "grid-loss":
    "World Bank - electric power transmission & distribution losses (% of output). Chronic grid loss tracks infrastructure decay, Infrastructure & Connectivity context.",
  "energy-mix":
    "Our World in Data - fossil-fuel share of electricity generation by country. Structural context for energy-supply exposure.",
  sanctions:
    "US OFAC SDN + EU consolidated list - entities added to or removed from sanctions lists, attributed to the country their programme names. Political & Governance context; not scored into country risk.",
  "food-price-index":
    "FAO - global monthly Food Price Index. Food price spikes are a well-established driver of political instability (see the 2007-08 and 2010-11 spikes preceding the Arab Spring).",
  "air-quality":
    "Open-Meteo - model-estimated PM2.5 at the same 12 monitored capitals as Weather. Environmental context only, not fed into the risk model.",
  "major-ports":
    "NGA World Port Index - the 417 large and medium seaports worldwide (US government data, public domain). Supply-chain context; an expanded feed card also names any major port within 50 km of the event.",
  "internet-censorship":
    "OONI - per country, the share of website tests in the last 7 days that hit a confirmed block page, and the share flagged as possible interference. Counts blocking of any kind, including gambling and piracy lists. Data CC BY-NC-SA 4.0, ooni.org; these derived rates are shared under the same licence.",
  "port-congestion":
    "IMF PortWatch - daily vessel transits through the world's 28 major maritime chokepoints, Infrastructure & Connectivity / Supply Chain context.",
  "trade-balance":
    "UN Comtrade - top export partners for a curated set of geopolitically significant economies. Structural trade-exposure context.",
};

// Poll intervals per layer - long enough to respect free-tier rate limits,
// short enough to feel "live" for the fast-moving ones.
export const DATA_LAYER_POLL_MS: Record<DataLayerId, number> = {
  flights: 20_000,
  "commercial-flights": 20_000,
  weather: 5 * 60_000,
  gdp: 60 * 60_000,
  population: 60 * 60_000,
  cyber: 30 * 60_000,
  // Same 5-minute floor as weather - frequent enough to feel live without
  // adding meaningfully to the request volume concern documented in
  // docs/TELEGRAM_SOURCES.md (this layer's own route also caches).
  telegram: 5 * 60_000,
  // Matched to each route's own withCache TTL (see the route files) -
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
  // Static snapshot built into the deployment; one fetch per session.
  "major-ports": 24 * 60 * 60_000,
  // Matched to each route's cache (see the route files).
  "internet-censorship": 60 * 60_000,
  // Written weekly by the sync-sanctions job; the route only reads stored
  // rows, so polling faster than this refreshes nothing.
  sanctions: 60 * 60_000,
};
