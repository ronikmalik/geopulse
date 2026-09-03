export const CATEGORIES = [
  "us-iran",
  "russia-ukraine",
  "israel-palestine",
  "china-taiwan",
  "north-korea",
  "political-instability",
  "humanitarian",
  "earthquake",
  "natural-disaster",
  "climate-hazard",
  "infrastructure-outage",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  "us-iran": "US – Iran",
  "russia-ukraine": "Russia – Ukraine",
  "israel-palestine": "Israel – Palestine",
  "china-taiwan": "China – Taiwan",
  "north-korea": "North Korea",
  "political-instability": "Political Instability",
  humanitarian: "Humanitarian Crisis",
  earthquake: "Earthquakes",
  "natural-disaster": "Natural Hazards",
  "climate-hazard": "Climate Hazards",
  "infrastructure-outage": "Infrastructure Outages",
  other: "Other",
};

// Categories driven by a GDELT text-search query. Feed-driven categories
// (earthquake, natural-disaster, climate-hazard, infrastructure-outage)
// arrive pre-classified with their own source module and don't need a
// query here.
export const NEWS_CATEGORIES = [
  "us-iran",
  "russia-ukraine",
  "israel-palestine",
  "china-taiwan",
  "north-korea",
  "political-instability",
  "humanitarian",
] as const;

export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

export const CATEGORY_QUERIES: Record<NewsCategory, string> = {
  "us-iran": "Iran AND (US OR United States OR sanctions OR strike OR nuclear)",
  "russia-ukraine": "Russia AND Ukraine AND (strike OR missile OR troops OR front)",
  "israel-palestine": "Israel AND (Gaza OR Palestine OR Hamas OR Hezbollah OR Lebanon)",
  "china-taiwan": "China AND Taiwan AND (military OR incursion OR strait)",
  "north-korea": "North Korea AND (missile OR nuclear OR Kim Jong)",
  "political-instability":
    '(coup OR "military takeover" OR "state of emergency" OR "martial law") OR (protests AND (crackdown OR banned)) OR (election AND (fraud OR annulled OR postponed OR disputed)) OR (government AND (collapse OR resign OR ousted OR overthrown))',
  humanitarian:
    '(famine OR "food insecurity" OR malnutrition) OR (refugees OR "internally displaced" OR displacement) OR ("humanitarian crisis" OR "humanitarian emergency") OR (disease AND (outbreak OR epidemic))',
};

// CORE categories are on by default and shown as the always-visible top-bar
// pills — this is the original GeoPulse view (the five hand-picked
// flashpoints). LAYER categories are extra signal types that stay off by
// default and are opted into from the Data Layers dashboard, so the main
// view doesn't get cluttered as more sources/pillars are added over time.
export const CORE_NEWS_CATEGORIES = [
  "us-iran",
  "russia-ukraine",
  "israel-palestine",
  "china-taiwan",
  "north-korea",
] as const;

export const CORE_CATEGORIES = [...CORE_NEWS_CATEGORIES, "other"] as const;

export const LAYER_CATEGORIES = [
  "political-instability",
  "humanitarian",
  "earthquake",
  "natural-disaster",
  "climate-hazard",
  "infrastructure-outage",
] as const;
