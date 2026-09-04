// Licensing / commercial-use registry for every external data source this
// app touches (wired into ingest.ts, a /api/layers/* route, or the
// standalone modules in src/lib/sources/). "Public and accessible without
// a key" is not the same as "cleared for commercial redistribution" —
// this table is the single place that distinction gets tracked, per the
// blueprint's provider-table requirement (docs/ROADMAP.md section 12).
//
// `commercialUse` and `redistributionAllowed` reflect a best-effort, non-
// legal reading of each provider's published terms as of `termsLastChecked`
// — re-verify against the source before relying on this for anything with
// real commercial stakes.
export interface SourceLicenseInfo {
  id: string;
  provider: string;
  url: string;
  license: string;
  commercialUse: "yes" | "no" | "unclear" | "non-commercial-only";
  redistributionAllowed: "yes" | "no" | "unclear" | "attribution-required";
  attributionRequired: boolean;
  cachingAllowed: boolean;
  maxCacheAgeNotes: string;
  rateLimit: string;
  apiKeyRequired: boolean;
  termsLastChecked: string; // YYYY-MM-DD
}

export const SOURCE_REGISTRY: SourceLicenseInfo[] = [
  {
    id: "gdelt",
    provider: "GDELT Project (GDELT DOC 2.0 API)",
    url: "https://www.gdeltproject.org/",
    license: "Public domain (US government-funded, CC0-equivalent per GDELT terms)",
    commercialUse: "yes",
    redistributionAllowed: "yes",
    attributionRequired: false,
    cachingAllowed: true,
    maxCacheAgeNotes: "No stated limit; app re-fetches every ingest cycle regardless.",
    rateLimit: "Soft — avoid tight loops; ~1 req/sec sustained is safe.",
    apiKeyRequired: false,
    termsLastChecked: "2026-09-02",
  },
  {
    id: "rss",
    provider:
      "19 outlet RSS feeds across North America, Europe, Asia-Pacific, the Middle East, Africa, and Latin America — see src/lib/sources/rss.ts for the full list and docs/SOURCE_CREDIBILITY.md for the per-outlet bias/reliability vetting",
    url: "https://www.bbci.co.uk/news/10318089",
    license: "Publisher-specific — RSS provided for personal/non-commercial syndication",
    commercialUse: "unclear",
    redistributionAllowed: "attribution-required",
    attributionRequired: true,
    cachingAllowed: true,
    maxCacheAgeNotes: "Headline/summary + source link only — no full-article reproduction.",
    rateLimit: "Unpublished — poll politely (this app: every ~15 min).",
    apiKeyRequired: false,
    termsLastChecked: "2026-09-03",
  },
  {
    id: "usgs",
    provider: "USGS Earthquake Hazards Program",
    url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php",
    license: "US government work — public domain",
    commercialUse: "yes",
    redistributionAllowed: "yes",
    attributionRequired: false,
    cachingAllowed: true,
    maxCacheAgeNotes: "Feed updates continuously; no caching restriction.",
    rateLimit: "Unpublished; this app polls every ~15 min.",
    apiKeyRequired: false,
    termsLastChecked: "2026-09-02",
  },
  {
    id: "eonet",
    provider: "NASA EONET",
    url: "https://eonet.gsfc.nasa.gov/docs/v3",
    license: "US government work — public domain (NASA open data policy)",
    commercialUse: "yes",
    redistributionAllowed: "yes",
    attributionRequired: false,
    cachingAllowed: true,
    maxCacheAgeNotes: "No stated limit.",
    rateLimit: "Unpublished.",
    apiKeyRequired: false,
    termsLastChecked: "2026-09-02",
  },
  {
    id: "gdacs",
    provider: "GDACS (Global Disaster Alert and Coordination System)",
    url: "https://www.gdacs.org/",
    license: "Free for use; a joint EU/UN initiative, no explicit commercial-redistribution clause published",
    commercialUse: "unclear",
    redistributionAllowed: "unclear",
    attributionRequired: true,
    cachingAllowed: true,
    maxCacheAgeNotes: "No stated limit.",
    rateLimit: "Unpublished — poll politely.",
    apiKeyRequired: false,
    termsLastChecked: "2026-09-02",
  },
  {
    id: "ioda",
    provider: "IODA — Georgia Tech Internet Intelligence Lab / CAIDA",
    url: "https://ioda.inetintel.cc.gatech.edu/",
    license: "Copyright Georgia Tech Research Corporation; API published for public use",
    commercialUse: "unclear",
    redistributionAllowed: "attribution-required",
    attributionRequired: true,
    cachingAllowed: true,
    maxCacheAgeNotes: "This app dedupes to one row per country per UTC day.",
    rateLimit: "Unpublished — poll politely.",
    apiKeyRequired: false,
    termsLastChecked: "2026-09-02",
  },
  {
    id: "cisa-kev",
    provider: "CISA Known Exploited Vulnerabilities Catalog",
    url: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog",
    license: "US government work — public domain",
    commercialUse: "yes",
    redistributionAllowed: "yes",
    attributionRequired: false,
    cachingAllowed: true,
    maxCacheAgeNotes: "Catalog updates as CISA adds entries; this app caches 30 min.",
    rateLimit: "Unpublished; single static JSON file.",
    apiKeyRequired: false,
    termsLastChecked: "2026-09-02",
  },
  {
    id: "frankfurter",
    provider: "Frankfurter (ECB reference rates)",
    url: "https://frankfurter.dev/",
    license: "MIT-licensed API wrapper over ECB reference rates",
    commercialUse: "yes",
    redistributionAllowed: "yes",
    attributionRequired: false,
    cachingAllowed: true,
    maxCacheAgeNotes: "ECB publishes once per business day (~16:00 CET).",
    rateLimit: "Generous free tier; no key.",
    apiKeyRequired: false,
    termsLastChecked: "2026-09-02",
  },
  {
    id: "fawazahmed0-currency-api",
    provider: "fawazahmed0/exchange-api (community, via jsDelivr)",
    url: "https://github.com/fawazahmed0/exchange-api",
    license: "Unlicense (public domain)",
    commercialUse: "yes",
    redistributionAllowed: "yes",
    attributionRequired: false,
    cachingAllowed: true,
    maxCacheAgeNotes: "Updates daily.",
    rateLimit: "jsDelivr CDN — generous, no key.",
    apiKeyRequired: false,
    termsLastChecked: "2026-09-02",
  },
  {
    id: "worldbank",
    provider: "World Bank Open Data",
    url: "https://datahelpdesk.worldbank.org/knowledgebase/articles/889392",
    license: "CC BY 4.0",
    commercialUse: "yes",
    redistributionAllowed: "attribution-required",
    attributionRequired: true,
    cachingAllowed: true,
    maxCacheAgeNotes: "Annual/slow-moving indicators — safe to cache for hours.",
    rateLimit: "Generous free tier; no key.",
    apiKeyRequired: false,
    termsLastChecked: "2026-09-02",
  },
  {
    id: "cftc",
    provider: "CFTC Commitments of Traders",
    url: "https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm",
    license: "US government work — public domain",
    commercialUse: "yes",
    redistributionAllowed: "yes",
    attributionRequired: false,
    cachingAllowed: true,
    maxCacheAgeNotes: "Published weekly (Fridays).",
    rateLimit: "Unpublished.",
    apiKeyRequired: false,
    termsLastChecked: "2026-09-02",
  },
  {
    id: "opensky",
    provider: "OpenSky Network",
    url: "https://openskynetwork.github.io/opensky-api/",
    license: "OpenSky Network data use policy — non-commercial research use only without a data agreement",
    commercialUse: "non-commercial-only",
    redistributionAllowed: "no",
    attributionRequired: true,
    cachingAllowed: true,
    maxCacheAgeNotes: "Live tracking — cache seconds, not longer.",
    rateLimit: "400 credits/day unauthenticated.",
    apiKeyRequired: false,
    termsLastChecked: "2026-09-02",
  },
  {
    id: "adsblol",
    provider: "adsb.lol",
    url: "https://api.adsb.lol/docs",
    license: "Community/volunteer-run — free public API, no formal commercial license published",
    commercialUse: "unclear",
    redistributionAllowed: "unclear",
    attributionRequired: true,
    cachingAllowed: true,
    maxCacheAgeNotes: "Live tracking — cache seconds, not longer.",
    rateLimit: "Unpublished — poll politely.",
    apiKeyRequired: false,
    termsLastChecked: "2026-09-02",
  },
  {
    id: "openmeteo",
    provider: "Open-Meteo",
    url: "https://open-meteo.com/en/terms",
    license: "CC BY 4.0 for non-commercial; commercial use requires a paid plan above free-tier volume",
    commercialUse: "unclear",
    redistributionAllowed: "attribution-required",
    attributionRequired: true,
    cachingAllowed: true,
    maxCacheAgeNotes: "Current conditions — cache minutes, not hours.",
    rateLimit: "10,000 calls/day free tier.",
    apiKeyRequired: false,
    termsLastChecked: "2026-09-02",
  },
  {
    id: "finnhub",
    provider: "Finnhub",
    url: "https://finnhub.io/docs/api",
    license: "Finnhub API terms — free tier for personal/development use",
    commercialUse: "unclear",
    redistributionAllowed: "unclear",
    attributionRequired: false,
    cachingAllowed: true,
    maxCacheAgeNotes: "Quotes — cache minutes.",
    rateLimit: "60 calls/min free tier.",
    apiKeyRequired: true,
    termsLastChecked: "2026-09-02",
  },
];

export function getSourceLicense(id: string): SourceLicenseInfo | undefined {
  return SOURCE_REGISTRY.find((s) => s.id === id);
}
