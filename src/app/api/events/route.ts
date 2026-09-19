import { NextRequest } from "next/server";
import { getEventsByCountry, getEventsByCategories } from "@/lib/risk";
import { badRequest, cachedJson, parseCategoriesParam, parseCountryParam } from "@/lib/apiParams";

// Backs the country-drill-down Feed view (clicking a country on the globe)
// and, since 2026-09-08, the category-layer-isolation Feed view (toggling
// down to a subset of categories in CategoryFilter/LayersDashboard).
// Separate from the live feed poll (/api/events/feed), which only ever
// holds a shared, cross-country/cross-category recent-N buffer client-
// side — this queries the DB scoped to whichever filter is active, so a
// country or category whose events fell out of that shared buffer still
// shows its real feed. See getEventsByCountry/getEventsByCategories in
// src/lib/risk.ts.
//
// Inputs are validated up front (2026-09-19): `country` must be a 2-letter
// code, `categories` must all be real CATEGORIES slugs — anything else is
// a 400 before any DB work. Responses are CDN-cacheable for 30s: a drill-
// down that many viewers open on the same hot country is one function
// invocation, not one per viewer.
const CDN_SECONDS = 30;

export async function GET(req: NextRequest) {
  const rawCountry = req.nextUrl.searchParams.get("country");
  if (rawCountry) {
    const country = parseCountryParam(rawCountry);
    if (!country) return badRequest("country must be a 2-letter ISO code");
    const events = await getEventsByCountry(country);
    return cachedJson({ events }, CDN_SECONDS);
  }

  const rawCategories = req.nextUrl.searchParams.get("categories");
  if (rawCategories) {
    const categories = parseCategoriesParam(rawCategories);
    if (!categories) return badRequest("categories must be a comma-separated list of known category slugs");
    const events = await getEventsByCategories(categories);
    return cachedJson({ events }, CDN_SECONDS);
  }

  return badRequest("country or categories is required");
}
