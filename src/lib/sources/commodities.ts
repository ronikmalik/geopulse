// Commodity prices for a geopolitical-risk audience: oil/gas are the most
// direct transmission channel from conflict to the global economy (Strait
// of Hormuz chokepoint risk, Russia-Ukraine gas cutoffs to Europe), and
// gold/silver are the standard safe-haven barometer during exactly those
// events — same "headline feature" logic as forex.ts, just the commodity
// side of it.
//
// Two providers:
// - EIA (U.S. Energy Information Administration) v2 API — official daily
//   spot prices for WTI/Brent crude and Henry Hub natural gas. Requires a
//   free MAP_KEY (instant email signup, no approval wait) —
//   https://www.eia.gov/opendata/register.php — set as EIA_API_KEY. Same
//   soft-no-op-without-a-key pattern as firms.ts's FIRMS_MAP_KEY. This
//   replaced FRED's public fredgraph.csv export (dropped 2026-09-11):
//   every FRED request timed out specifically from Vercel's serverless
//   runtime (confirmed live via `vercel logs`, including after adding
//   realistic browser headers and hitting a fresh deployment directly
//   with X-Vercel-Cache: MISS), while the exact same request succeeded
//   instantly and repeatedly from a residential IP — an IP/ASN-level
//   block on Vercel's outbound range, not anything fixable with headers.
//   Yahoo Finance's unofficial chart API and stooq.com's CSV export were
//   tried before FRED and rejected for the same class of reason: Yahoo
//   429'd within a handful of requests and stooq now gates its CSV
//   endpoint behind a JS proof-of-work challenge. EIA's route/series
//   shape (petroleum/pri/spt: RWTC, RBRTE; natural-gas/pri/fut: RNGWHHD)
//   is documented from EIA's own v2 API browser and confirmed reachable
//   (clean 403 API_KEY_MISSING JSON, not a timeout/404) without a key —
//   NOT yet live-verified end-to-end with a real key as of 2026-09-11.
// - fawazahmed0/currency-api (the same community CDN forex.ts already
//   uses for RUB/UAH) carries precious metals as pseudo-currencies (XAU,
//   XAG) against USD, updated daily, no key required.
import { fetchMarketQuotes } from "./yahooQuote";

const EIA_ENDPOINT = "https://api.eia.gov/v2";
const CDN_CURRENCY_ENDPOINT = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api";

export interface CommodityPrice {
  id: string;
  label: string;
  unit: string;
  price: number;
  changePct: number | null;
  date: string;
  // See ForexRate.asOf/source in forex.ts — same meaning here (2026-09-20).
  asOf: string;
  source: "market" | "reference";
}

interface EiaSeriesConfig {
  route: string;
  seriesId: string;
  label: string;
  unit: string;
}

const EIA_SERIES: EiaSeriesConfig[] = [
  { route: "petroleum/pri/spt", seriesId: "RWTC", label: "Crude Oil (WTI)", unit: "$/bbl" },
  { route: "petroleum/pri/spt", seriesId: "RBRTE", label: "Crude Oil (Brent)", unit: "$/bbl" },
  {
    route: "natural-gas/pri/fut",
    seriesId: "RNGWHHD",
    label: "Natural Gas (Henry Hub)",
    unit: "$/MMBtu",
  },
];

interface EiaDataRow {
  period: string;
  value: string | number;
}

interface EiaResponse {
  response?: { data?: EiaDataRow[] };
}

async function fetchEiaSeries(
  cfg: EiaSeriesConfig,
  apiKey: string,
): Promise<CommodityPrice | null> {
  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  params.set("frequency", "daily");
  params.set("data[0]", "value");
  params.append("facets[series][]", cfg.seriesId);
  params.set("sort[0][column]", "period");
  params.set("sort[0][direction]", "desc");
  params.set("length", "5");

  let res: Response;
  try {
    res = await fetch(`${EIA_ENDPOINT}/${cfg.route}/data/?${params.toString()}`, {
      headers: { "User-Agent": "geopulse-globe/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.error(`EIA fetch failed (${cfg.seriesId}): ${err}`);
    return null;
  }
  if (!res.ok) {
    console.error(`EIA fetch failed (${cfg.seriesId}): ${res.status}`);
    return null;
  }

  const json = (await res.json()) as EiaResponse;
  const rows = (json.response?.data ?? [])
    .map((r) => ({ period: r.period, value: Number(r.value) }))
    .filter((r) => !Number.isNaN(r.value))
    // Don't trust the API's own sort ordering blindly.
    .sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0));

  if (rows.length === 0) return null;
  const latest = rows[0];
  const prev = rows.length > 1 ? rows[1] : null;
  const changePct = prev ? ((latest.value - prev.value) / prev.value) * 100 : null;

  return {
    id: cfg.seriesId,
    label: cfg.label,
    unit: cfg.unit,
    price: latest.value,
    changePct,
    date: latest.period,
    asOf: `${latest.period}T00:00:00.000Z`,
    source: "reference",
  };
}

async function fetchEnergyPrices(): Promise<CommodityPrice[]> {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) return [];
  const results = await Promise.all(EIA_SERIES.map((s) => fetchEiaSeries(s, apiKey)));
  return results.filter((r): r is CommodityPrice => r != null);
}

interface MetalConfig {
  symbol: string;
  label: string;
  unit: string;
}

const METALS: MetalConfig[] = [
  { symbol: "xau", label: "Gold", unit: "$/oz" },
  { symbol: "xag", label: "Silver", unit: "$/oz" },
];

interface CdnCurrencyResponse {
  date: string;
  usd: Record<string, number>;
}

async function fetchCdnRatesOn(dateOrLatest: string): Promise<CdnCurrencyResponse> {
  const res = await fetch(`${CDN_CURRENCY_ENDPOINT}@${dateOrLatest}/v1/currencies/usd.json`, {
    headers: { "User-Agent": "geopulse-globe/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Currency CDN fetch failed: ${res.status}`);
  return (await res.json()) as CdnCurrencyResponse;
}

async function fetchMetalPrices(): Promise<CommodityPrice[]> {
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

  let latest: CdnCurrencyResponse;
  let previous: CdnCurrencyResponse | null;
  try {
    [latest, previous] = await Promise.all([
      fetchCdnRatesOn("latest"),
      fetchCdnRatesOn(twoDaysAgo).catch(() => null),
    ]);
  } catch (err) {
    console.error(`Metal price fetch failed: ${err}`);
    return [];
  }

  return METALS.filter((m) => latest.usd[m.symbol] != null).map((m) => {
    const perUsd = latest.usd[m.symbol]; // metal units per 1 USD
    const price = 1 / perUsd; // USD per troy oz
    const prevPerUsd = previous?.usd[m.symbol];
    const changePct =
      prevPerUsd != null ? ((price - 1 / prevPerUsd) / (1 / prevPerUsd)) * 100 : null;
    return {
      id: m.symbol,
      label: m.label,
      unit: m.unit,
      price,
      changePct,
      date: latest.date,
      asOf: `${latest.date}T00:00:00.000Z`,
      source: "reference" as const,
    };
  });
}

// Intraday path (2026-09-20): front-month futures from Yahoo Finance. Ids
// are kept identical to the reference path's (EIA series ids for energy,
// the metal symbols) so nothing keyed on `id` downstream changes. Per-
// instrument fallback: any instrument Yahoo didn't return is filled from
// the daily provider, so a partial Yahoo outage never blanks the ticker.
const MARKET_INSTRUMENTS: { id: string; symbol: string; label: string; unit: string }[] = [
  { id: "RWTC", symbol: "CL=F", label: "Crude Oil (WTI)", unit: "$/bbl" },
  { id: "RBRTE", symbol: "BZ=F", label: "Crude Oil (Brent)", unit: "$/bbl" },
  { id: "RNGWHHD", symbol: "NG=F", label: "Natural Gas (Henry Hub)", unit: "$/MMBtu" },
  { id: "xau", symbol: "GC=F", label: "Gold", unit: "$/oz" },
  { id: "xag", symbol: "SI=F", label: "Silver", unit: "$/oz" },
];

async function fetchMarketCommodityPrices(): Promise<Map<string, CommodityPrice>> {
  const quotes = await fetchMarketQuotes(MARKET_INSTRUMENTS.map((m) => m.symbol));
  const out = new Map<string, CommodityPrice>();
  for (const m of MARKET_INSTRUMENTS) {
    const q = quotes.get(m.symbol);
    if (!q) continue;
    out.set(m.id, {
      id: m.id,
      label: m.label,
      unit: m.unit,
      price: q.price,
      changePct: q.changePct,
      date: q.asOf.toISOString().slice(0, 10),
      asOf: q.asOf.toISOString(),
      source: "market",
    });
  }
  return out;
}

export async function fetchCommodityPrices(): Promise<CommodityPrice[]> {
  const market = await fetchMarketCommodityPrices().catch((err) => {
    console.error(`Market commodity quotes failed: ${err}`);
    return new Map<string, CommodityPrice>();
  });
  // Only hit the daily providers for whatever the market path is missing.
  const missing = MARKET_INSTRUMENTS.filter((m) => !market.has(m.id));
  let reference: CommodityPrice[] = [];
  if (missing.length > 0) {
    const [energy, metals] = await Promise.all([fetchEnergyPrices(), fetchMetalPrices()]);
    reference = [...energy, ...metals];
  }
  const byId = new Map(reference.map((r) => [r.id, r]));
  return MARKET_INSTRUMENTS.map((m) => market.get(m.id) ?? byId.get(m.id)).filter((c): c is CommodityPrice => c != null);
}
