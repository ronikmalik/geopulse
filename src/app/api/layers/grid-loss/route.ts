import { NextResponse } from "next/server";
import { fetchWorldBankIndicator } from "@/lib/sources/worldbank";
import { withCache } from "@/lib/layerCache";

// EG.ELC.LOSS.ZS — electric power transmission & distribution losses, %
// of output. Same World Bank Indicators API src/lib/sources/worldbank.ts
// already calls for GDP/population (see gdp/route.ts) — just a different
// indicator code, no new adapter code needed since fetchWorldBankIndicator
// already takes any indicator. Sorted descending (highest loss first):
// chronic grid loss tracks infrastructure decay/power theft, the opposite
// ranking direction from gdp/population's "biggest" framing.
export async function GET() {
  try {
    const countries = await withCache("layer:grid-loss", 24 * 60 * 60_000, () =>
      fetchWorldBankIndicator("EG.ELC.LOSS.ZS", { perPage: 300 }),
    );

    const top = [...countries]
      .filter((c) => c.value != null)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
      .slice(0, 10);

    return NextResponse.json({ countries: top });
  } catch (err) {
    console.error(`layer:grid-loss failed: ${err}`);
    return NextResponse.json({ countries: [] });
  }
}
