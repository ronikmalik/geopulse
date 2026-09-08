import { NextRequest, NextResponse } from "next/server";
import { getEventsByCountry, getEventsByCategories } from "@/lib/risk";

// Backs the country-drill-down Feed view (clicking a country on the globe)
// and, since 2026-09-08, the category-layer-isolation Feed view (toggling
// down to a subset of categories in CategoryFilter/LayersDashboard).
// Separate from /api/stream, which only ever holds a shared, cross-
// country/cross-category recent-N buffer client-side — this queries the
// DB scoped to whichever filter is active, so a country or category whose
// events fell out of that shared buffer still shows its real feed. See
// getEventsByCountry/getEventsByCategories in src/lib/risk.ts.
export async function GET(req: NextRequest) {
  const country = req.nextUrl.searchParams.get("country");
  if (country) {
    const events = await getEventsByCountry(country);
    return NextResponse.json({ events });
  }

  const categoriesParam = req.nextUrl.searchParams.get("categories");
  if (categoriesParam) {
    const categories = categoriesParam
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    if (categories.length === 0) {
      return NextResponse.json({ error: "categories must be non-empty" }, { status: 400 });
    }
    const events = await getEventsByCategories(categories);
    return NextResponse.json({ events });
  }

  return NextResponse.json({ error: "country or categories is required" }, { status: 400 });
}
