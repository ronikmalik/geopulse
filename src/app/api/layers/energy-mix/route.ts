import { NextResponse } from "next/server";
import { fetchOwidEnergyMix } from "@/lib/sources/owidEnergy";
import { fetchWorldBankIndicator } from "@/lib/sources/worldbank";
import { withCache } from "@/lib/layerCache";

const MIN_POPULATION = 5_000_000;

// Sorted by fossil-fuel share of electricity generation, descending — of
// OWID's many possible cuts (renewable share, per-source breakdown), this
// is the one that maps most directly to a geopolitical exposure: a
// country generating most of its power from fossil fuels is exposed to
// import-supply shocks, price spikes, and sanctions on fuel suppliers in
// a way a hydro/nuclear/renewable-heavy grid isn't. Annual data — 24h
// cache matches gdp/population/grid-loss's treatment of other slow-moving
// World Bank structural indicators.
//
// A pure "% fossil, descending" sort surfaces a wall of tiny territories
// tied at 100% (British Virgin Islands, Comoros, etc. — a single small
// oil-fired plant is "100% fossil" just as much as Saudi Arabia's grid
// is) before any country large enough for that exposure to actually mean
// something geopolitically. Cross-referencing against World Bank
// population (same indicator already used by the population layer, so no
// new source) and dropping anything under 5M filters out that noise
// without needing a maintained allow-list of "real" countries.
export async function GET() {
  try {
    const [countries, population] = await withCache(
      "layer:energy-mix",
      24 * 60 * 60_000,
      async () => {
        const [energyCountries, populationCountries] = await Promise.all([
          fetchOwidEnergyMix(),
          fetchWorldBankIndicator("SP.POP.TOTL"),
        ]);
        return [energyCountries, populationCountries] as const;
      },
    );

    const populationByIso3 = new Map(
      population.map((p) => [p.countryIso3, p.value]),
    );

    const top = [...countries]
      .filter((c) => (populationByIso3.get(c.countryIso3) ?? 0) >= MIN_POPULATION)
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);

    return NextResponse.json({ countries: top });
  } catch (err) {
    console.error(`layer:energy-mix failed: ${err}`);
    return NextResponse.json({ countries: [] });
  }
}
