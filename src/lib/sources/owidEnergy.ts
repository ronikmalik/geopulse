// Our World in Data's combined energy dataset — public CSV, no key, no
// rate limit. https://github.com/owid/energy-data. Verified live
// 2026-09-08: the grapher CSV export (ourworldindata.org/grapher/
// energy-mix.csv) only carries total supply, not a source breakdown — the
// per-source shares (coal/gas/oil/nuclear/renewables % of electricity)
// live in the fuller raw dataset instead, so that's the one this fetches.
// ~9MB/23k rows; fine to fetch in full given the 24h+ cache this sits
// behind (data is annual, never intraday).
const OWID_ENERGY_ENDPOINT =
  "https://github.com/owid/energy-data/raw/master/owid-energy-data.csv";

export interface OwidEnergyBreakdown {
  fossilSharePct: number | null;
  renewablesSharePct: number | null;
  coalSharePct: number | null;
  gasSharePct: number | null;
  oilSharePct: number | null;
  nuclearSharePct: number | null;
  hydroSharePct: number | null;
  solarSharePct: number | null;
  windSharePct: number | null;
}

export interface OwidEnergyCountry {
  countryIso3: string;
  countryName: string;
  year: string;
  // Primary sort metric — see the "why fossil share" comment in
  // src/app/api/layers/energy-mix/route.ts. Duplicated into `value` (as
  // well as breakdown.fossilSharePct) to match the {countryIso3,
  // countryName, value} shape gdp/population/grid-loss all use.
  value: number;
  breakdown: OwidEnergyBreakdown;
}

// Column positions in the current header (verified live 2026-09-08, not
// assumed — OWID has reshuffled this file's columns across schema
// versions before). No quoted/comma-embedded fields exist in this CSV
// (checked: no `"` anywhere in the file, no country name contains a
// comma), so a plain split is safe — no need for a real CSV parser.
interface ColumnIndex {
  country: number;
  year: number;
  isoCode: number;
  fossilShareElec: number;
  renewablesShareElec: number;
  coalShareElec: number;
  gasShareElec: number;
  oilShareElec: number;
  nuclearShareElec: number;
  hydroShareElec: number;
  solarShareElec: number;
  windShareElec: number;
}

function resolveColumns(header: string[]): ColumnIndex {
  const idx = (name: string) => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`OWID energy CSV missing expected column "${name}"`);
    return i;
  };
  return {
    country: idx("country"),
    year: idx("year"),
    isoCode: idx("iso_code"),
    fossilShareElec: idx("fossil_share_elec"),
    renewablesShareElec: idx("renewables_share_elec"),
    coalShareElec: idx("coal_share_elec"),
    gasShareElec: idx("gas_share_elec"),
    oilShareElec: idx("oil_share_elec"),
    nuclearShareElec: idx("nuclear_share_elec"),
    hydroShareElec: idx("hydro_share_elec"),
    solarShareElec: idx("solar_share_elec"),
    windShareElec: idx("wind_share_elec"),
  };
}

function toNum(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Keeps, per country, only the row for its most recent year that actually
// has a fossil_share_elec value — OWID's coverage year varies country to
// country, so there's no single "latest year" that works for everyone.
export async function fetchOwidEnergyMix(): Promise<OwidEnergyCountry[]> {
  let res: Response;
  try {
    res = await fetch(OWID_ENERGY_ENDPOINT, {
      headers: { "User-Agent": "geopulse-globe/1.0" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(`OWID energy request failed: ${err}`);
  }

  if (!res.ok) {
    console.error(`OWID energy fetch failed: ${res.status}`);
    return [];
  }

  const text = await res.text();
  const lines = text.split("\n");
  if (lines.length < 2) return [];

  const col = resolveColumns(lines[0].split(","));
  const latestByCountry = new Map<string, OwidEnergyCountry>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cells = line.split(",");
    const isoCode = cells[col.isoCode];
    // Blank iso_code marks OWID's own region/aggregate/historical-entity
    // rows (e.g. "Africa", "European Union (27)", "Czechoslovakia") —
    // same "must have a real 3-letter code" filter worldbank.ts applies.
    if (!isoCode || isoCode.length !== 3) continue;

    const fossilSharePct = toNum(cells[col.fossilShareElec]);
    if (fossilSharePct == null) continue;

    const year = cells[col.year];
    const existing = latestByCountry.get(isoCode);
    if (existing && Number(existing.year) >= Number(year)) continue;

    latestByCountry.set(isoCode, {
      countryIso3: isoCode,
      countryName: cells[col.country],
      year,
      value: fossilSharePct,
      breakdown: {
        fossilSharePct,
        renewablesSharePct: toNum(cells[col.renewablesShareElec]),
        coalSharePct: toNum(cells[col.coalShareElec]),
        gasSharePct: toNum(cells[col.gasShareElec]),
        oilSharePct: toNum(cells[col.oilShareElec]),
        nuclearSharePct: toNum(cells[col.nuclearShareElec]),
        hydroSharePct: toNum(cells[col.hydroShareElec]),
        solarSharePct: toNum(cells[col.solarShareElec]),
        windSharePct: toNum(cells[col.windShareElec]),
      },
    });
  }

  return [...latestByCountry.values()];
}
