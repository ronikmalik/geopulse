import { NextRequest } from "next/server";
import { currencyForCountry } from "@/lib/countryCurrency";
import { stockIndexForCountry } from "@/lib/countryStockIndex";
import { fetchUsdRateFor } from "@/lib/sources/forex";
import { fetchIndexQuote, FinnhubNotConfiguredError } from "@/lib/sources/finnhub";
import { fetchCountryDossier } from "@/lib/countryDossier";
import { withCache } from "@/lib/layerCache";
import { badRequest, cachedJson, parseCountryParam } from "@/lib/apiParams";

export async function GET(req: NextRequest) {
  // Validated to a strict 2-letter code (2026-09-19): this value is
  // interpolated into upstream World Bank / forex request URLs by
  // fetchCountryDossier/fetchUsdRateFor, so it must never be free text.
  const iso2 = parseCountryParam(req.nextUrl.searchParams.get("country"));
  if (!iso2) return badRequest("country must be a 2-letter ISO code");

  const snapshot = await withCache(`country-snapshot:${iso2}`, 5 * 60_000, async () => {
    const currencyCode = currencyForCountry(iso2);
    const indexMeta = stockIndexForCountry(iso2);

    const [currency, index] = await Promise.all([
      currencyCode
        ? fetchUsdRateFor(currencyCode).catch(() => null)
        : Promise.resolve(null),
      indexMeta
        ? fetchIndexQuote(indexMeta.symbol).catch((err) => {
            if (!(err instanceof FinnhubNotConfiguredError)) {
              console.error(`Index quote failed for ${iso2}: ${err}`);
            }
            return null;
          })
        : Promise.resolve(null),
    ]);

    return {
      country: iso2,
      currency,
      index: index && indexMeta ? { ...index, name: indexMeta.name } : null,
    };
  });

  // GDP/population/region barely change day to day, unlike currency/index
  // above — a much longer cache avoids re-hitting World Bank on every
  // dossier open without going stale in any way that matters.
  const dossier = await withCache(`country-dossier:${iso2}`, 24 * 60 * 60_000, () =>
    fetchCountryDossier(iso2).catch(() => null),
  );

  return cachedJson({ ...snapshot, dossier }, 300);
}
