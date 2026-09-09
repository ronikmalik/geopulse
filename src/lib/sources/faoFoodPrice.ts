// FAO Food Price Index (FFPI) — public CSV, no key. Verified live
// 2026-09-08: fao.org's index landing page links this CSV directly (no
// stable un-dated URL is published elsewhere, but this one has held
// steady across FAO's monthly updates so far). A single global monthly
// index (2014-2016=100), not per-country — food price spikes are a
// well-established driver of political instability (the 2007-08 and
// 2010-11 spikes preceding the Arab Spring are the standard reference
// point), so this is a meaningful signal even as one global number with a
// trend, same "single value + change" shape as forex.ts's SingleCurrencyRate.
const FAO_FFPI_ENDPOINT =
  "https://www.fao.org/media/docs/worldfoodsituationlibraries/default-document-library/food_price_indices_data.csv";

export interface FaoFoodPriceIndex {
  value: number;
  date: string; // "YYYY-MM"
  changePct: number | null; // vs. the prior month
}

// The file is a spreadsheet export: a title row, a "2014-2016=100" base
// note, the real header, a blank row, then one row per month
// ("YYYY-MM,FFPI,Meat,Dairy,Cereals,Oils,Sugar", plus a long tail of
// empty trailing columns from the source spreadsheet). No quoted fields
// anywhere in it, so a plain split is safe.
export async function fetchFaoFoodPriceIndex(): Promise<FaoFoodPriceIndex | null> {
  let res: Response;
  try {
    res = await fetch(FAO_FFPI_ENDPOINT, {
      headers: { "User-Agent": "geopulse-globe/1.0" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new Error(`FAO Food Price Index request failed: ${err}`);
  }

  if (!res.ok) {
    console.error(`FAO Food Price Index fetch failed: ${res.status}`);
    return null;
  }

  const text = await res.text();
  const monthRows = text
    .split("\n")
    .map((line) => line.split(",").slice(0, 2))
    .filter(([date, value]) => /^\d{4}-\d{2}$/.test(date ?? "") && value && !isNaN(Number(value)));

  if (monthRows.length === 0) return null;

  const [latestDate, latestValue] = monthRows[monthRows.length - 1];
  const prev = monthRows.length >= 2 ? monthRows[monthRows.length - 2] : null;
  const prevValue = prev ? Number(prev[1]) : null;
  const value = Number(latestValue);

  return {
    value,
    date: latestDate,
    changePct: prevValue != null ? ((value - prevValue) / prevValue) * 100 : null,
  };
}
