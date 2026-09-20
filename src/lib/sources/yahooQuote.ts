// Intraday market quotes from Yahoo Finance's public chart endpoint
// (2026-09-20). No key, no account. Added because the Forex and
// Energy/Commodities panels were labelled "live" but were fed by DAILY
// reference data: Frankfurter/ECB publishes one fixing per business day
// (nothing on weekends), and the EIA daily spot series lags several days —
// on 2026-09-20 the ticker still showed Brent at $130.80 from the 2026-09-15
// Houthi-strike spike while the market had it at $99.29 (Friday's close).
// A geopolitical-risk dashboard whose oil price is five days stale during
// the week oil moved 25% is not doing its one job.
//
// This is an unofficial endpoint, so it is used the way an unofficial
// endpoint should be: as the PRIMARY source with a short timeout and the
// previous daily providers kept as fallback (see forex.ts/commodities.ts),
// behind a 60s server cache + 60s CDN cache so total request volume is a
// few per minute regardless of how many tabs are open. If Yahoo ever
// blocks or changes shape, the panels degrade to yesterday's reference
// numbers with an "as of" date, exactly as they were before this file.
//
// Symbol conventions (verified live 2026-09-20): "XXX=X" quotes USD/XXX
// (units of XXX per 1 USD) for every currency tried, including RUB and UAH
// which the ECB doesn't carry; "=F" are front-month futures (CL=F WTI,
// BZ=F Brent, NG=F Henry Hub, GC=F gold, SI=F silver), quoted in USD.
// meta.regularMarketPrice is the last trade (or last close when the
// market is shut), meta.chartPreviousClose the prior session's close —
// both taken from the 1-day chart so "previous" means the previous
// SESSION, which is what a day-change percentage should mean.
const CHART_ENDPOINT = "https://query1.finance.yahoo.com/v8/finance/chart";
const REQUEST_TIMEOUT_MS = 8_000;
const CONCURRENCY = 6;

export interface MarketQuote {
  symbol: string;
  price: number;
  previousClose: number | null;
  changePct: number | null;
  asOf: Date;
}

interface ChartResponse {
  chart?: {
    result?: {
      meta?: {
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
        regularMarketTime?: number;
      };
    }[];
    error?: unknown;
  };
}

async function fetchOne(symbol: string): Promise<MarketQuote | null> {
  try {
    const res = await fetch(`${CHART_ENDPOINT}/${encodeURIComponent(symbol)}?interval=5m&range=1d`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; geopulse-globe/1.0)", Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as ChartResponse;
    const meta = data.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    const time = meta?.regularMarketTime;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || typeof time !== "number") return null;
    const previousClose = typeof meta?.chartPreviousClose === "number" ? meta.chartPreviousClose : typeof meta?.previousClose === "number" ? meta.previousClose : null;
    const changePct = previousClose && previousClose > 0 ? ((price - previousClose) / previousClose) * 100 : null;
    return { symbol, price, previousClose, changePct, asOf: new Date(time * 1000) };
  } catch (err) {
    console.error(`Yahoo quote failed for ${symbol}: ${err}`);
    return null;
  }
}

// Fetches every symbol, a few at a time; a symbol that fails is simply
// absent from the result so callers can fall back per-symbol.
export async function fetchMarketQuotes(symbols: readonly string[]): Promise<Map<string, MarketQuote>> {
  const out = new Map<string, MarketQuote>();
  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const chunk = symbols.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(fetchOne));
    for (const q of results) if (q) out.set(q.symbol, q);
  }
  return out;
}
