// Finnhub quote API — requires a free API key (FINNHUB_API_KEY env var),
// unlike every other source in this directory. CONFIRMED 2026-09-08: the
// free tier's real-time coverage is US equities only — non-US indices in
// src/lib/countryStockIndex.ts need a paid Finnhub plan to resolve (they
// come back as a silent null, not an error). See docs/API_SOURCES.md.
// https://finnhub.io/docs/api/quote
const FINNHUB_ENDPOINT = "https://finnhub.io/api/v1/quote";

export interface IndexQuote {
  symbol: string;
  price: number;
  change: number;
  changePct: number;
  previousClose: number;
}

export class FinnhubNotConfiguredError extends Error {
  constructor() {
    super("FINNHUB_API_KEY is not set");
    this.name = "FinnhubNotConfiguredError";
  }
}

export async function fetchIndexQuote(symbol: string): Promise<IndexQuote | null> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) throw new FinnhubNotConfiguredError();

  const params = new URLSearchParams({ symbol, token: apiKey });

  let res: Response;
  try {
    res = await fetch(`${FINNHUB_ENDPOINT}?${params.toString()}`, {
      headers: { "User-Agent": "geopulse-globe/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(`Finnhub request failed: ${err}`);
  }

  if (!res.ok) {
    console.error(`Finnhub fetch failed for ${symbol}: ${res.status}`);
    return null;
  }

  const data = (await res.json()) as {
    c: number;
    d: number | null;
    dp: number | null;
    pc: number;
  };

  // Finnhub returns all-zero fields for a symbol it doesn't recognize
  // rather than a 4xx — treat that as "no data" instead of a fake quote.
  if (data.c === 0 && data.pc === 0) return null;

  return {
    symbol,
    price: data.c,
    change: data.d ?? 0,
    changePct: data.dp ?? 0,
    previousClose: data.pc,
  };
}
