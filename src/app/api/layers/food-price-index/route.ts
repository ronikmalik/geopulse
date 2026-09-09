import { NextResponse } from "next/server";
import { fetchFaoFoodPriceIndex } from "@/lib/sources/faoFoodPrice";
import { withCache } from "@/lib/layerCache";

// Monthly data — cached a full day, same treatment as the other
// slow-moving structural layers (gdp/population/grid-loss/energy-mix).
export async function GET() {
  try {
    const index = await withCache("layer:food-price-index", 24 * 60 * 60_000, () =>
      fetchFaoFoodPriceIndex(),
    );
    return NextResponse.json({ index });
  } catch (err) {
    console.error(`layer:food-price-index failed: ${err}`);
    return NextResponse.json({ index: null });
  }
}
