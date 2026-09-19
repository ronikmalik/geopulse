import { NextResponse } from "next/server";
import { fetchWorldBankIndicator } from "@/lib/sources/worldbank";
import { withCache } from "@/lib/layerCache";
import { cachedJson } from "@/lib/apiParams";

// See src/app/api/layers/flights/route.ts's 2026-09-04 comment.
export async function GET() {
  try {
    const countries = await withCache("layer:gdp", 24 * 60 * 60_000, () =>
      fetchWorldBankIndicator("NY.GDP.MKTP.CD", { perPage: 300 }),
    );

    const top = [...countries]
      .filter((c) => c.value != null)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
      .slice(0, 10);

    return cachedJson({ countries: top }, 300);
  } catch (err) {
    console.error(`layer:gdp failed: ${err}`);
    return NextResponse.json({ countries: [] });
  }
}
