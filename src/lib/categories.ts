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

// User question (2026-09-09): "why am i not getting news on india, pakistan,
// south asia generally, the -stans in central asia, west africa, etc.?" Root
// cause investigated live: the 5 named-flashpoint queries above obviously
// don't cover these regions, and the two generic catch-alls
// (political-instability/humanitarian) are the ONLY GDELT queries that
// could — but their own keyword nets (coup/martial-law/election-fraud,
// famine/refugee/disease-outbreak) never match a Kashmir border clash or a
// Central Asian protest crackdown unless it happens to also use that exact
// vocabulary. Worse, runIngest's ROTATION_CHUNK_SIZE=1 means those two
// queries — the app's only GDELT path into these regions at all — only run
// once every ~7 rotation cycles (~105 min), not every cycle.
//
// Fix has two parts, both requiring MORE query slots than cron-job.org's
// hard 30s per-request timeout allows the main rotation to spend (see
// runIngest's own comment on ROTATION_CHUNK_SIZE) — so this whole set runs
// through a SEPARATE, dedicated path (see runIngest's priorityGdelt option
// and .github/workflows/ingest-priority.yml) triggered directly by GitHub
// Actions, which has no such timeout:
//   1. Re-run political-instability/humanitarian far more often (every
//      ~15 min instead of ~105) — same query text, just not rotation-
//      starved anymore.
//   2. Two genuinely NEW queries targeting the specific gap: named
//      insurgent/separatist actors and border-tension vocabulary for South
//      Asia and Central Asia that no existing query searches for at all.
//      Not folded into political-instability's own query text above —
//      that string is already ~238 characters, and a live test
//      (2026-09-09) found GDELT's real query-length ceiling sits somewhere
//      between 238 and 263 chars, leaving almost no headroom.
// West Africa isn't a third query here — it's already reasonably covered
// by RSS (premium-times-nigeria/allafrica/africanews/african-arguments,
// see sources/rss.ts) in a way India/Pakistan and Central Asia structurally
// aren't: docs/SOURCE_CREDIBILITY.md's 2026-09-08 gap-filling pass found
// every Pakistani outlet candidate fails on documented censorship pressure
// and Central Asia has essentially zero free-press RSS presence at all
// (Eurasianet, the one high-credibility specialist, is Cloudflare-blocked)
// — a confirmed dead end re-checked the day before this fix, not an
// unexamined gap.
// ALWAYS run every priorityGdelt cycle — the two broad catch-alls, kept
// maximally fresh since they're this app's most general-purpose reach into
// any country outside the 5 named flashpoints.
export const PRIORITY_GDELT_ALWAYS: { category: NewsCategory; query: string }[] = [
  { category: "political-instability", query: CATEGORY_QUERIES["political-instability"] },
  { category: "humanitarian", query: CATEGORY_QUERIES["humanitarian"] },
];

// 2026-09-10 (user request: "build dedicated queries for all 200+
// countries... keep building more and more"): this list is designed to
// grow indefinitely without needing any other code change — see
// PRIORITY_GDELT_ROTATION_CHUNK_SIZE in ingest.ts, which rotates through
// this list in chunks each cycle (the same rotation-not-run-everything
// idiom the main /api/ingest route already uses for its 5 named
// flashpoints) rather than running the whole list every time — GDELT
// rate limits and GitHub Actions' 6-minute job timeout both cap how many
// queries can run in one cycle, so this scales by rotating through more
// entries over a longer full-cycle time, not by running more per cycle.
// Each entry should be a real, researched query for a specific country or
// tight regional cluster's actual current conflict/instability/
// humanitarian-crisis vocabulary (named actors, specific disputes) — not
// a generic term already covered by PRIORITY_GDELT_ALWAYS above.
export const PRIORITY_GDELT_ROTATION: { category: NewsCategory; query: string }[] = [
  {
    category: "political-instability",
    // Afghanistan (bare "Taliban"/"ISIS-K"/"Khorasan Province", already
    // mapped to AF in countryNames.ts) had no GDELT reach at all before
    // this: docs/SOURCE_CREDIBILITY.md explicitly names "Pakistan and
    // Afghanistan... South Asia's actual terrorism theater" as a real,
    // still-open gap.
    query:
      '"Tehrik-i-Taliban" OR "Lashkar-e-Taiba" OR "Jaish-e-Mohammed" OR Naxalite OR Kashmir OR "Line of Control" OR (India AND Pakistan AND border) OR (Afghanistan AND Taliban) OR Baluchistan',
  },
  {
    category: "political-instability",
    query:
      "(Kazakhstan OR Uzbekistan OR Kyrgyzstan OR Tajikistan OR Turkmenistan) AND (unrest OR protest OR clash OR border OR crackdown OR coup)",
  },
  // Bangladesh/Nepal/Sri Lanka is docs/SOURCE_CREDIBILITY.md's own named
  // remaining gap ("no dedicated outlet clears the bar... simply unrated
  // by any tracker") — zero GDELT reach and no RSS/regional-umbrella
  // coverage before this.
  {
    category: "political-instability",
    query:
      '(Bangladesh OR Nepal OR "Sri Lanka") AND (protest OR unrest OR crackdown OR coup OR "state of emergency" OR clash OR strike)',
  },
  // Guyana was one of 32 countries with literally zero coverage
  // capability (see countryCentroids.ts/countryNames.ts) — added for a
  // real, current story: the Guyana-Venezuela Essequibo territorial
  // dispute, not just completeness.
  {
    category: "political-instability",
    query: "Guyana AND Venezuela AND (Essequibo OR border OR territorial OR troops)",
  },
  // countryNames.ts already maps several real, active Latin American
  // armed actors (FARC, Sendero Luminoso, Sinaloa/Jalisco cartels, MS-13,
  // Barrio 18) — enough that this app already treats cartel/gang conflict
  // as a tracked signal — but no GDELT query searched for this
  // vocabulary before this.
  {
    category: "political-instability",
    query:
      '"cartel violence" OR "gang violence" OR "Sendero Luminoso" OR FARC OR (Haiti AND gang) OR (Mexico AND cartel) OR (Ecuador AND (gang OR cartel))',
  },
];

// Kept for any external reference to the old combined shape — always
// ALWAYS-queries first, matching the priority order they used to run in.
export const PRIORITY_GDELT_QUERIES: { category: NewsCategory; query: string }[] = [
  ...PRIORITY_GDELT_ALWAYS,
  ...PRIORITY_GDELT_ROTATION,
];

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
