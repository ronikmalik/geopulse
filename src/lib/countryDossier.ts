import { ALPHA2_TO_ALPHA3 } from "@/lib/iso3";
import {
  fetchWorldBankIndicatorForCountry,
  fetchWorldBankCountryMeta,
} from "@/lib/sources/worldbank";

export interface CountryDossierFigure {
  value: number;
  year: string;
}

export interface CountryDossier {
  country: string; // ISO alpha-2
  countryName: string;
  region: string | null;
  incomeLevel: string | null;
  capitalCity: string | null;
  gdpUsd: CountryDossierFigure | null;
  population: CountryDossierFigure | null;
  summary: string;
}

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

// GDP/population/region/income data straight from World Bank — every
// figure here is a real published statistic with its own reporting year,
// nothing composed or inferred. The one-line summary below is template
// text filled in from those same numbers, not generated — same
// no-LLM-necessary discipline as src/lib/history.ts's summarizeHistory.
export async function fetchCountryDossier(iso2: string): Promise<CountryDossier | null> {
  const iso3 = ALPHA2_TO_ALPHA3[iso2.toUpperCase()];
  if (!iso3) return null;

  const [gdp, population, meta] = await Promise.all([
    fetchWorldBankIndicatorForCountry(iso3, "NY.GDP.MKTP.CD").catch(() => null),
    fetchWorldBankIndicatorForCountry(iso3, "SP.POP.TOTL").catch(() => null),
    fetchWorldBankCountryMeta(iso3).catch(() => null),
  ]);

  if (!gdp && !population && !meta) return null;

  const countryName = meta?.name ?? gdp?.countryName ?? population?.countryName ?? iso2;

  const region = meta?.region?.trim() || null;

  const parts: string[] = [];
  if (region) {
    parts.push(
      meta?.incomeLevel && meta.incomeLevel !== "Aggregates"
        ? `${region}, ${meta.incomeLevel.toLowerCase()} economy`
        : region,
    );
  }
  if (gdp?.value != null) {
    parts.push(`GDP $${compactNumber.format(gdp.value)} (${gdp.year})`);
  }
  if (population?.value != null) {
    parts.push(`population ${compactNumber.format(population.value)} (${population.year})`);
  }
  if (meta?.capitalCity) {
    parts.push(`capital ${meta.capitalCity}`);
  }

  // Some World Bank capital names already end in a period (e.g. "Washington
  // D.C."), so don't double it up with the sentence-closing one.
  const body = parts.join(" · ");
  const summary =
    parts.length > 0
      ? `${countryName} — ${body}${body.endsWith(".") ? "" : "."}`
      : `${countryName} — no World Bank data available.`;

  return {
    country: iso2.toUpperCase(),
    countryName,
    region,
    incomeLevel: meta?.incomeLevel ?? null,
    capitalCity: meta?.capitalCity ?? null,
    gdpUsd: gdp?.value != null ? { value: gdp.value, year: gdp.year } : null,
    population: population?.value != null ? { value: population.value, year: population.year } : null,
    summary,
  };
}
