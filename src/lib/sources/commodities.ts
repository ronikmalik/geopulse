// Commodity prices for a geopolitical-risk audience: gold/silver are the
// standard safe-haven barometer during exactly the kind of events this
// app tracks (conflict, sanctions, currency stress) — same "headline
// feature" logic as forex.ts, just the commodity side of it.
//
// Same no-API-key bar as forex.ts: fawazahmed0/currency-api (the same
// community CDN forex.ts already uses for RUB/UAH) carries precious
// metals as pseudo-currencies (XAU, XAG) against USD, updated daily.
//
// Oil/gas (WTI, Brent, Henry Hub) were tried via FRED's public
// fredgraph.csv export and dropped 2026-09-11: every request timed out
// specifically from Vercel's serverless runtime (confirmed live via
// `vercel logs`, including after adding realistic browser headers and
// hitting a fresh deployment directly with X-Vercel-Cache: MISS), while
// the exact same request succeeded instantly and repeatedly from a
// residential IP. That points to an IP/ASN-level block on Vercel's
// outbound range rather than anything fixable with headers. Yahoo
// Finance's unofficial chart API and stooq.com's CSV export were tried
// before that and rejected for the same reason this app avoids them
// generally — Yahoo 429'd within a handful of requests and stooq now
// gates its CSV endpoint behind a JS proof-of-work challenge. Revisit
// energy prices via a registered-key official source (e.g. EIA's free
// API, api.eia.gov) if that's worth the extra env var.
const CDN_CURRENCY_ENDPOINT = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api";

export interface CommodityPrice {
  id: string;
  label: string;
  unit: string;
  price: number;
  changePct: number | null;
  date: string;
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
    };
  });
}

export async function fetchCommodityPrices(): Promise<CommodityPrice[]> {
  return fetchMetalPrices();
}
