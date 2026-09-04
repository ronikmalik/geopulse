// STANDALONE / NOT INTEGRATED — see src/lib/sources/README.md.
//
// World Bank World Development Indicators, no API key required.
// https://datahelpdesk.worldbank.org/knowledgebase/articles/889392
const WORLD_BANK_ENDPOINT = "https://api.worldbank.org/v2/country/all/indicator";

export interface WorldBankObservation {
  indicatorId: string;
  countryIso3: string;
  countryName: string;
  year: string;
  value: number | null;
}

interface WorldBankEntry {
  indicator: { id: string; value: string };
  country: { id: string; value: string };
  countryiso3code: string;
  date: string;
  value: number | null;
}

// World Bank mixes real countries and region/income-group aggregates (e.g.
// "World", "Africa Eastern and Southern") into the same response, both
// using 3-letter codes — so length alone can't distinguish them. This is
// the World Bank's own stable list of aggregate codes (WLD, region groups,
// income groups) as used by their "country" vs "region" API classification.
const WORLD_BANK_AGGREGATE_CODES = new Set([
  "AFE", "AFW", "ARB", "CEB", "CSS", "EAP", "EAR", "EAS", "ECA", "ECS",
  "EMU", "EUU", "FCS", "HIC", "HPC", "IBD", "IBT", "IDA", "IDB", "IDX",
  "LAC", "LCN", "LDC", "LIC", "LMC", "LMY", "LTE", "MEA", "MIC", "MNA",
  "NAC", "OED", "OSS", "PRE", "PSS", "PST", "SAS", "SSA", "SSF", "SST",
  "TEA", "TEC", "TLA", "TMN", "TSA", "TSS", "UMC", "WLD",
]);

// Not exhaustive — the World Bank has ~50 aggregate groupings and this
// covers the common ones plus any entry with a blank/non-3-letter code.
// Good enough for a "mostly real countries" view; a consumer that needs
// exact classification should cross-check against the /v2/country
// endpoint's own `region.id` field instead.
function isAggregateRegion(iso3: string): boolean {
  return iso3.length !== 3 || WORLD_BANK_AGGREGATE_CODES.has(iso3);
}

export async function fetchWorldBankIndicator(
  indicatorCode: string,
  { perPage = 300 }: { perPage?: number } = {},
): Promise<WorldBankObservation[]> {
  const params = new URLSearchParams({
    format: "json",
    per_page: String(perPage),
    mrnev: "1", // most recent non-empty value per country
  });

  let res: Response;
  try {
    res = await fetch(
      `${WORLD_BANK_ENDPOINT}/${indicatorCode}?${params.toString()}`,
      {
        headers: { "User-Agent": "geopulse-globe/1.0" },
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch (err) {
    throw new Error(`World Bank request failed: ${err}`);
  }

  if (!res.ok) {
    console.error(`World Bank fetch failed: ${res.status}`);
    return [];
  }

  const data = (await res.json()) as [unknown, WorldBankEntry[] | null];
  const entries = data[1] ?? [];

  return entries
    .filter((e) => !isAggregateRegion(e.countryiso3code))
    .map((e) => ({
      indicatorId: e.indicator.id,
      countryIso3: e.countryiso3code,
      countryName: e.country.value,
      year: e.date,
      value: e.value,
    }));
}

// Single-country, single-indicator lookup — used for the country
// click-through dossier (one country at a time) rather than the top-10
// ticker layers above (which need the full ranked list).
export async function fetchWorldBankIndicatorForCountry(
  countryIso3: string,
  indicatorCode: string,
): Promise<WorldBankObservation | null> {
  let res: Response;
  try {
    res = await fetch(
      `${WORLD_BANK_ENDPOINT.replace("/country/all/", `/country/${countryIso3}/`)}/${indicatorCode}?format=json&mrnev=1`,
      {
        headers: { "User-Agent": "geopulse-globe/1.0" },
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch (err) {
    throw new Error(`World Bank request failed: ${err}`);
  }

  if (!res.ok) {
    console.error(`World Bank fetch failed for ${countryIso3}: ${res.status}`);
    return null;
  }

  const data = (await res.json()) as [unknown, WorldBankEntry[] | null];
  const entry = data[1]?.[0];
  if (!entry || entry.value == null) return null;

  return {
    indicatorId: entry.indicator.id,
    countryIso3: entry.countryiso3code,
    countryName: entry.country.value,
    year: entry.date,
    value: entry.value,
  };
}

export interface WorldBankCountryMeta {
  name: string;
  region: string;
  incomeLevel: string;
  capitalCity: string | null;
}

interface WorldBankCountryEntry {
  name: string;
  region: { value: string };
  incomeLevel: { value: string };
  capitalCity: string;
}

// Country metadata (region, income classification, capital) — no
// indicator value, just the descriptive fields used to compose the
// dossier's one-line summary.
export async function fetchWorldBankCountryMeta(
  countryIso3: string,
): Promise<WorldBankCountryMeta | null> {
  let res: Response;
  try {
    res = await fetch(
      `https://api.worldbank.org/v2/country/${countryIso3}?format=json`,
      {
        headers: { "User-Agent": "geopulse-globe/1.0" },
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch (err) {
    throw new Error(`World Bank country-meta request failed: ${err}`);
  }

  if (!res.ok) {
    console.error(`World Bank country-meta fetch failed for ${countryIso3}: ${res.status}`);
    return null;
  }

  const data = (await res.json()) as [unknown, WorldBankCountryEntry[] | null];
  const entry = data[1]?.[0];
  if (!entry) return null;

  return {
    name: entry.name,
    region: entry.region.value,
    incomeLevel: entry.incomeLevel.value,
    capitalCity: entry.capitalCity || null,
  };
}
