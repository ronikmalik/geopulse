// Commodity prices for a geopolitical-risk audience: oil and gas are the
// most direct, well-documented transmission channel from conflict to the
// global economy (Strait of Hormuz chokepoint risk, Russia-Ukraine gas
// cutoffs to Europe), and gold/silver are the standard safe-haven barometer
// during exactly those events — same "headline feature" logic as
// forex.ts, just the commodity side of it.
//
// Two providers, same no-API-key bar as forex.ts:
// - FRED (Federal Reserve Bank of St. Louis) graph-export CSV — the same
//   public, unauthenticated endpoint that powers FRED's own embeddable
//   graphs (not a scraped/reverse-engineered one), used here for official
//   daily spot prices on crude oil (WTI, Brent) and Henry Hub natural gas.
//   https://fred.stlouisfed.org/graph/fredgraph.csv?id=<series>&cosd=...
//   Verified live 2026-09-10. Note: Yahoo Finance's unofficial chart API
//   and stooq.com's CSV export were both tried first and rejected — Yahoo
//   429'd within a handful of requests from one IP, and stooq now gates
//   its CSV endpoint behind a JS proof-of-work challenge. FRED's CSV
//   export had neither problem and is an official government source.
// - fawazahmed0/currency-api (the same community CDN forex.ts already uses
//   for RUB/UAH) carries precious metals as pseudo-currencies (XAU, XAG)
//   against USD, updated daily — used here for gold/silver, which FRED
//   stopped publishing in 2015 after an LBMA licensing dispute.
const FRED_CSV_ENDPOINT = "https://fred.stlouisfed.org/graph/fredgraph.csv";
const CDN_CURRENCY_ENDPOINT = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api";

export interface CommodityPrice {
  id: string;
  label: string;
  unit: string;
  price: number;
  changePct: number | null;
  date: string;
}

interface FredSeriesConfig {
  id: string;
  label: string;
  unit: string;
}

// Daily official spot prices. Henry Hub/WTI/Brent are the three energy
// benchmarks most directly exposed to Middle East and Russia/Europe risk.
const FRED_SERIES: FredSeriesConfig[] = [
  { id: "DCOILWTICO", label: "Crude Oil (WTI)", unit: "$/bbl" },
  { id: "DCOILBRENTEU", label: "Crude Oil (Brent)", unit: "$/bbl" },
  { id: "DHHNGSP", label: "Natural Gas (Henry Hub)", unit: "$/MMBtu" },
];

interface MetalConfig {
  symbol: string;
  label: string;
  unit: string;
}

const METALS: MetalConfig[] = [
  { symbol: "xau", label: "Gold", unit: "$/oz" },
  { symbol: "xag", label: "Silver", unit: "$/oz" },
];

// 10 calendar days is comfortably more than any US market holiday/weekend
// stretch, so there's always at least two real (non-blank) observations to
// diff for a change% even right after e.g. a long weekend.
const FRED_LOOKBACK_DAYS = 10;

// FRED's CSV export timed out on every request from Vercel's serverless
// runtime (verified live 2026-09-11 via `vercel logs`) while working fine
// from a residential IP with the exact same generic User-Agent Frankfurter
// already uses successfully from the same runtime — a WAF (Akamai fronts
// fred.stlouisfed.org) silently dropping/holding requests that look
// bot-like (minimal headers) from a datacenter IP range is the standard
// explanation for that specific split. Sending realistic browser headers
// is the standard mitigation; this endpoint's actual designed consumer is
// a browser embedding a FRED graph, so this isn't spoofing anything it
// wasn't already expecting.
const FRED_BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/csv,text/plain,*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

async function fetchFredSeries(series: FredSeriesConfig): Promise<CommodityPrice | null> {
  const start = new Date(Date.now() - FRED_LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  let res: Response;
  try {
    res = await fetch(`${FRED_CSV_ENDPOINT}?id=${series.id}&cosd=${start}`, {
      headers: FRED_BROWSER_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.error(`FRED fetch failed (${series.id}): ${err}`);
    return null;
  }
  if (!res.ok) {
    console.error(`FRED fetch failed (${series.id}): ${res.status}`);
    return null;
  }

  const text = await res.text();
  const rows = text
    .trim()
    .split("\n")
    .slice(1) // drop the "observation_date,<series>" header row
    .map((line) => {
      const [date, value] = line.split(",");
      return { date, value: value === "." || value === "" ? null : Number(value) };
    })
    .filter(
      (r): r is { date: string; value: number } => r.value != null && !Number.isNaN(r.value),
    );

  if (rows.length === 0) return null;
  const latest = rows[rows.length - 1];
  const prev = rows.length > 1 ? rows[rows.length - 2] : null;
  const changePct = prev ? ((latest.value - prev.value) / prev.value) * 100 : null;

  return {
    id: series.id,
    label: series.label,
    unit: series.unit,
    price: latest.value,
    changePct,
    date: latest.date,
  };
}

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
    // Non-fatal — the FRED energy series still work without this.
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
  const [energyResults, metals] = await Promise.all([
    Promise.all(FRED_SERIES.map(fetchFredSeries)),
    fetchMetalPrices(),
  ]);
  const energy = energyResults.filter((r): r is CommodityPrice => r != null);
  return [...energy, ...metals];
}
