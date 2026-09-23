import {
  pgTable,
  serial,
  text,
  doublePrecision,
  smallint,
  integer,
  timestamp,
  index,
  boolean,
  customType,
  unique,
} from "drizzle-orm/pg-core";

// pgvector's `vector(N)` column type has no first-class Drizzle helper, so
// this is a thin customType: the wire format pgvector expects for a vector
// literal ("[0.1,0.2,...]") is identical to a JSON array of numbers, so
// to/fromDriver are just JSON (de)serialization, not a real parser. See
// src/lib/embeddings.ts for what actually populates this column and
// docs/ARCHITECTURE.md for why (Gemini text-embedding-004, 768 dims).
const vector = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 768})`;
  },
  toDriver(value: number[]): string {
    return JSON.stringify(value);
  },
  fromDriver(value: string): number[] {
    return JSON.parse(value);
  },
});

// Same thing at half the bytes (2026-09-22). pgvector's `halfvec` stores
// each component as a 16-bit float instead of 32, so a 768-dim embedding
// costs 1,536 bytes of column plus a correspondingly smaller HNSW index,
// not 3,072. The wire format is byte-identical to `vector` ("[0.1,...]"),
// so to/fromDriver stay plain JSON and every JS-side reader
// (textClassifierTraining, narrativeNoveltyScoring, …) is unaffected.
//
// Why: the two tables this is used on are 98 MB of the database's 130 MB,
// and Neon's free plan stops at 500 MB — see docs/ARCHITECTURE.md §12.
// Halving the vectors roughly doubles how long this project can keep
// accumulating the historical corpus that everything downstream trains on.
//
// The precision cost is real but not meaningful here: float16 holds ~3
// decimal digits, embedding components sit in [-1, 1], and every consumer
// uses these vectors for *ranking* by cosine distance, never for an exact
// value. Verified on live data before shipping: for 8 probe rows, the
// top-10 neighbour SET was identical before and after, distances agreed
// to within 2.3e-5, and the only ordering changes were two exact-tie
// pairs swapping places — which is already nondeterministic. Measured
// effect: the database went from 130 MB to 86 MB in one migration.
// The narrative-cluster centroids and the
// calibration-pattern vectors stay `vector`: 101 rows between them, so
// there is nothing to save, and the centroids are averaged in JS where
// the extra precision is free.
const halfvec = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
  dataType(config) {
    return `halfvec(${config?.dimensions ?? 768})`;
  },
  toDriver(value: number[]): string {
    return JSON.stringify(value);
  },
  fromDriver(value: string): number[] {
    return JSON.parse(value);
  },
});

export const events = pgTable(
  "events",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(), // "gdelt" | "rss:<feed-name>"
    url: text("url").notNull().unique(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    category: text("category").notNull(), // "us-iran" | "russia-ukraine" | "other"
    location: text("location").notNull(),
    country: text("country"), // ISO 3166-1 alpha-2, e.g. "IR" — nullable for pre-existing rows
    lat: doublePrecision("lat").notNull(),
    lon: doublePrecision("lon").notNull(),
    severity: smallint("severity").notNull(), // 1-5
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Deterministic clustering key — see src/lib/correlation.ts. Events
    // sharing a key are treated as reports of the same developing story
    // rather than independent signals; nullable because it's computed at
    // ingest time and pre-existing rows predate it.
    correlationGroupId: text("correlation_group_id"),
    // NULL = this row is a standalone/primary story, shown in the main
    // feed. Non-null = this row is a same-content report of the primary
    // event with this id (a different outlet covering the same real
    // incident) — hidden from the main feed list, surfaced only as an
    // additional source when the primary is expanded. Computed at ingest
    // time by src/lib/eventDedup.ts via real title/summary similarity
    // against recent same-country/same-category events — deliberately NOT
    // the coarse country:pillar:day correlationGroupId above, which would
    // merge every distinct story in a pillar on the same day. The FK
    // constraint itself is added via raw SQL in the migrate route (Drizzle
    // self-references need an AnyPgColumn callback that adds more
    // complexity than the raw statement here is worth).
    primaryEventId: integer("primary_event_id"),
    // "pending" | "approved" | "rejected" — 2026-09-08 user request: the
    // Gemini review that used to happen only as a post-hoc audit
    // (classifier_audit) now gates the live feed itself. Rows from the
    // classified sources (RSS/GDELT/Telegram — wherever classifyByKeywords/
    // classifyGdeltItem run) are inserted "pending" and stay invisible to
    // every public read path (see the reviewStatus filter in
    // /api/events/feed, risk.ts, similarEvents.ts) until
    // reviewPendingEvents (classifierAudit.ts) promotes or rejects them,
    // almost always within the same or next ~15min ingest cycle. Direct
    // structural sources (USGS/EONET/GDACS/IODA/FIRMS) skip the gate
    // entirely — inserted "approved" — since there's no comparable
    // editorial judgment call in "a magnitude-6 earthquake happened at
    // these coordinates." A stale pending row past
    // PENDING_REVIEW_MAX_AGE_MS auto-promotes on the classifier's own
    // original verdict rather than staying invisible forever if Gemini
    // is ever unavailable — see reviewPendingEvents's own doc comment.
    // EXCEPT gdelt (2026-09-10): that source's stale-pending rows are
    // deliberately excluded from auto-promotion and can stay "pending"
    // indefinitely until a real Gemini review reaches them — see
    // PENDING_REVIEW_MAX_AGE_MINUTES's doc comment in classifierAudit.ts.
    // /api/events/feed accounts for this specifically (a gdelt row can't block
    // its ordering cursor the way any other still-resolving-within-30min
    // source's pending row can); risk.ts/similarEvents.ts need no special
    // handling since they're stateless reads, not an incremental cursor.
    // Existing rows were grandfathered to "approved" the moment this
    // column was added (see the migrate route) — this was never meant
    // to retroactively hide anything already live.
    reviewStatus: text("review_status").notNull().default("pending"),
    // Gemini's one-sentence reasoning at the moment reviewPendingEvents
    // approved/rejected this row (2026-09-20; empty when it agreed with
    // everything stored). Kept so a human grading a gate_review_samples
    // row can see WHY the gate decided what it did — without it the
    // gate's ~600 decisions/day were completely unexplainable after the
    // fact, which is how the self-taught "exclude Gaza" lesson ran for
    // four days before anyone could tell it was the cause.
    reviewReasoning: text("review_reasoning"),
    // Review rounds that returned no usable verdict for this row (see
    // MAX_REVIEW_ATTEMPTS in classifierAudit.ts). Without it such a row sat
    // at the head of the oldest-first queue indefinitely, resent to Gemini
    // every cycle.
    reviewAttempts: smallint("review_attempts").notNull().default(0),
    // NULL = not yet run through src/lib/geocodeBackfill.ts's Gemini
    // location-resolution pass — still sitting at classify.ts's
    // country-centroid fallback lat/lon. Set the moment that pass has
    // considered the row, whether or not it actually found a better
    // coordinate (see geocodeBackfill.ts's own doc comment for why a
    // failed lookup still gets stamped rather than retried forever).
    // Only ever populated for source LIKE 'rss:%' OR 'telegram:%' rows —
    // GDELT and the direct/structural sources (USGS/EONET/GDACS/IODA/
    // FIRMS, which already carry real event-level coordinates) are never
    // queried by that pass and stay NULL permanently; harmless, since
    // nothing reads this column as "needs attention" for those rows.
    geocodedAt: timestamp("geocoded_at", { withTimezone: true }),
    // NULL = a normal, currently-live row. Set to the activation time by
    // the front-end kill switch (see src/lib/killSwitch.ts and GET/POST
    // /api/admin/kill-switch, 2026-09-11 user request: "remove all of the
    // feed and let it recalibrate... the data should remain in archives...
    // earmarked as pre-kill switched"). Deliberately NOT a delete — every
    // row stays in this table exactly as classified, just excluded from
    // every user-facing read path (see NOT_KILL_SWITCHED in stream/route.ts,
    // risk.ts, eventVolumeAnomaly.ts, and eventDedup.ts's fetchRecentPrimaries
    // — the last of those matters even though dedup isn't user-facing itself:
    // without it, a fresh post-switch event could get matched as a duplicate
    // of a hidden pre-switch primary and inherit its invisibility). Restoring
    // (POST /api/admin/kill-switch with action=restore) clears this back to
    // NULL for every row, reversible at any time since nothing was deleted.
    preKillSwitchAt: timestamp("pre_kill_switch_at", { withTimezone: true }),
    // Roughly how many people live within 100 km of this event's
    // coordinates, distance-weighted (2026-09-22, src/lib/exposure.ts).
    // Stored rather than computed on read so a score can be reconstructed
    // from the row later, and so the 34k-settlement scan happens once per
    // event instead of once per page view.
    //
    // NULL means not computed — an event with no usable coordinates, or
    // one inserted before this existed. Null is NOT zero: an uncomputed
    // event keeps its unweighted score rather than being quietly demoted
    // for missing data.
    populationExposed: integer("population_exposed"),
  },
  (table) => [
    index("events_created_at_idx").on(table.createdAt),
    index("events_category_idx").on(table.category),
    index("events_country_idx").on(table.country),
    index("events_primary_event_id_idx").on(table.primaryEventId),
    index("events_review_status_idx").on(table.reviewStatus),
    index("events_geocoded_at_idx").on(table.geocodedAt),
    index("events_pre_kill_switch_at_idx").on(table.preKillSwitchAt),
    // Added 2026-09-09 alongside the anomaly-detection event-volume
    // signals (src/lib/eventVolumeAnomaly.ts), which GROUP BY
    // date_trunc('day', published_at) — but every date-window query in
    // this app already filters on this column (risk.ts's
    // getCountryCategoryRows/getEventsByCountry/getEventsByCategories),
    // so this benefits those existing hot paths too, not just the new one.
    index("events_published_at_idx").on(table.publishedAt),
  ],
);

export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;

// One row per source (e.g. "gdelt", "rss:bbc-world", "usgs", "ioda"),
// upserted on every ingest run — not a log, a current-state snapshot. This
// is what answers "did an upstream source silently stop working" without
// having to manually trigger ingest and read through error arrays; see
// getSourceHealth() in src/lib/ingest.ts and GET /api/admin/health.
export const sourceHealth = pgTable("source_health", {
  source: text("source").primaryKey(),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull(),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastItemCount: integer("last_item_count"),
  lastLatencyMs: integer("last_latency_ms"),
  lastError: text("last_error"),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
});

export type SourceHealthRow = typeof sourceHealth.$inferSelect;

// One row per country per daily snapshot (see src/lib/history.ts and the
// /api/admin/snapshot cron) — a running record of each country's Pulse
// Level/momentum over time, independent of the events table's 30-day
// scoring lookback. This is what lets "current pulse" eventually be
// compared against a country's own trailing baseline instead of a flat
// global threshold, and is the honest version of "let signals build on
// each other over time": real historical data, not a black-box model
// retrained on its own output.
export const countryStateHistory = pgTable(
  "country_state_history",
  {
    id: serial("id").primaryKey(),
    country: text("country").notNull(),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    score: doublePrecision("score").notNull(),
    threatLevel: smallint("threat_level").notNull(),
    momentum: smallint("momentum").notNull(),
    momentumDirection: smallint("momentum_direction").notNull(),
    eventCount: integer("event_count").notNull(),
    // Which methodology produced this score — see src/lib/scoringMethod.ts.
    // No default on purpose: every writer states it.
    scoringVersion: smallint("scoring_version").notNull(),
  },
  (table) => [
    index("country_state_history_country_idx").on(table.country),
    index("country_state_history_snapshot_at_idx").on(table.snapshotAt),
  ],
);

export type CountryStateHistoryRow = typeof countryStateHistory.$inferSelect;
export type NewCountryStateHistoryRow = typeof countryStateHistory.$inferInsert;

// The wide daily feature snapshot (2026-09-20) — the training table every
// forecasting model reads, written once a day by the `snapshot` job right
// after country_state_history. country_state_history stays as the narrow
// five-column series the Trends tab charts; this is the ~20-column
// companion the shadow risk model was starved of (six features, ten times
// worse than persistence — see docs/ARCHITECTURE.md §9a and the ML
// roadmap). Every column is derivable from tables that already exist, but
// NOT retroactively: `events` is a rolling 30-day window and the anomaly/
// novelty tables only hold their own recent state, so a feature not
// snapshotted today cannot be back-filled later. That is the whole reason
// this lands before any model that would use it.
//
// One row per (country, snapshot_date), UPSERTED — unlike
// country_state_history's plain insert, re-running the job on the same
// day overwrites rather than duplicates, so this table is safe under two
// schedulers or a manual re-run. Lagged features (t-1, t-3, t-7) are NOT
// stored: they are a self-join away at training time and storing them
// would only bake in one choice of lag.
//
// Nullable columns are "no data for this country today" (no aircraft
// tracked, no articles to score for novelty), distinct from 0.
export const countryFeatureDaily = pgTable(
  "country_feature_daily",
  {
    id: serial("id").primaryKey(),
    country: text("country").notNull(),
    snapshotDate: text("snapshot_date").notNull(), // YYYY-MM-DD (UTC)
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull().defaultNow(),
    // Headline state, duplicated from country_state_history so a training
    // query never has to join on a fuzzy timestamp match.
    score: doublePrecision("score").notNull(),
    // See src/lib/scoringMethod.ts — every stored score names its method.
    scoringVersion: smallint("scoring_version").notNull(),
    threatLevel: smallint("threat_level").notNull(),
    momentum: smallint("momentum").notNull(),
    momentumDirection: smallint("momentum_direction").notNull(),
    eventCount: integer("event_count").notNull(),
    // Decayed severity weight per pillar (PILLAR_IDS order in pillars.ts) —
    // the sub-scores that sum to `score`. Escalation is pillar-specific;
    // one total hides which pillar is moving.
    pillarGeopoliticalSecurity: doublePrecision("pillar_geopolitical_security").notNull().default(0),
    pillarPoliticalGovernance: doublePrecision("pillar_political_governance").notNull().default(0),
    pillarClimateEnvironment: doublePrecision("pillar_climate_environment").notNull().default(0),
    pillarNaturalBiologicalHazards: doublePrecision("pillar_natural_biological_hazards").notNull().default(0),
    pillarHumanSocial: doublePrecision("pillar_human_social").notNull().default(0),
    pillarInfrastructureConnectivity: doublePrecision("pillar_infrastructure_connectivity").notNull().default(0),
    pillarSupplyChainResource: doublePrecision("pillar_supply_chain_resource").notNull().default(0),
    pillarCyberTechnology: doublePrecision("pillar_cyber_technology").notNull().default(0),
    // Volume and intensity over rolling windows ending at snapshot time.
    events24h: integer("events_24h").notNull().default(0),
    events7d: integer("events_7d").notNull().default(0),
    severityMean24h: doublePrecision("severity_mean_24h"),
    severityMax24h: smallint("severity_max_24h"),
    severityMean7d: doublePrecision("severity_mean_7d"),
    // Source diversity and mix over 7d — cross-confirmed stories precede
    // sustained rises; Telegram is the early, noisy channel.
    distinctSources7d: integer("distinct_sources_7d").notNull().default(0),
    distinctFamilies7d: integer("distinct_families_7d").notNull().default(0),
    telegramShare7d: doublePrecision("telegram_share_7d"),
    gdeltShare7d: doublePrecision("gdelt_share_7d"),
    // Narrative novelty over the last 24h, from narrative_novelty_findings:
    // share of this country's scored articles that matched no known
    // cluster, and their mean distance to the nearest one.
    noveltyItems24h: integer("novelty_items_24h").notNull().default(0),
    novelShare24h: doublePrecision("novel_share_24h"),
    noveltyMeanDistance24h: doublePrecision("novelty_mean_distance_24h"),
    // Air/GNSS picture: latest daily value and its z-score against the
    // prior 14 days of the same series (null until 14 samples exist).
    aircraftMilitaryLatest: integer("aircraft_military_latest"),
    aircraftMilitaryZ14: doublePrecision("aircraft_military_z14"),
    aircraftCommercialLatest: integer("aircraft_commercial_latest"),
    aircraftCommercialZ14: doublePrecision("aircraft_commercial_z14"),
    gpsJammingLatest: integer("gps_jamming_latest"),
    gpsJammingZ14: doublePrecision("gps_jamming_z14"),
    // Recency of structural break: days since this country's last anomaly
    // finding of any signal type (null = never).
    daysSinceAnomaly: doublePrecision("days_since_anomaly"),
    anomalyCount7d: integer("anomaly_count_7d").notNull().default(0),
  },
  (table) => [
    unique("country_feature_daily_country_date_key").on(table.country, table.snapshotDate),
    index("country_feature_daily_snapshot_date_idx").on(table.snapshotDate),
  ],
);

export type CountryFeatureDailyRow = typeof countryFeatureDaily.$inferSelect;
export type NewCountryFeatureDailyRow = typeof countryFeatureDaily.$inferInsert;

// One row per country per daily snapshot of currently-tracked aircraft
// (see src/lib/flightBaseline.ts and the /api/admin/snapshot-flights
// cron) — the same "record it now, judge it later" pattern as
// countryStateHistory above. Anomaly detection now reads this table (see
// src/lib/anomalyBaseline.ts, 2026-09-09) once a country clears its own
// 14-sample baseline — this table started 2026-09-03, so that happens
// gradually per country rather than all at once.
//
// `kind` distinguishes military (the original, still the default for
// existing rows) from commercial (added 2026-09-09, see
// snapshotCommercialAircraftCounts in flightBaseline.ts) — one table, a
// discriminator column, rather than two near-identical tables; matches
// this schema's existing classifier_audit `kind` idiom below.
export const aircraftCountHistory = pgTable(
  "aircraft_count_history",
  {
    id: serial("id").primaryKey(),
    country: text("country").notNull(), // ISO 3166-1 alpha-2, reverse-geocoded from lat/lon
    snapshotAt: timestamp("snapshot_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    count: integer("count").notNull(),
    kind: text("kind").notNull().default("military"),
  },
  (table) => [
    index("aircraft_count_history_country_idx").on(table.country),
    index("aircraft_count_history_snapshot_at_idx").on(table.snapshotAt),
    index("aircraft_count_history_kind_idx").on(table.kind),
  ],
);

export type AircraftCountHistoryRow = typeof aircraftCountHistory.$inferSelect;
export type NewAircraftCountHistoryRow = typeof aircraftCountHistory.$inferInsert;

// One row per country per daily GPS/GNSS jamming snapshot (see
// src/lib/gpsJammingHistory.ts) — badCellCount/badAircraftCount mirror
// gpsjam.ts's own JammedRegion shape exactly (a count, not a percentage;
// see that file for why). Same baseline-building posture as
// aircraftCountHistory above — no anomaly detection until a country
// clears its own 14-sample baseline.
export const gpsJammingHistory = pgTable(
  "gps_jamming_history",
  {
    id: serial("id").primaryKey(),
    country: text("country").notNull(), // ISO 3166-1 alpha-2
    snapshotAt: timestamp("snapshot_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    badCellCount: integer("bad_cell_count").notNull(),
    badAircraftCount: integer("bad_aircraft_count").notNull(),
  },
  (table) => [
    index("gps_jamming_history_country_idx").on(table.country),
    index("gps_jamming_history_snapshot_at_idx").on(table.snapshotAt),
  ],
);

export type GpsJammingHistoryRow = typeof gpsJammingHistory.$inferSelect;
export type NewGpsJammingHistoryRow = typeof gpsJammingHistory.$inferInsert;

// Daily vessel transits through the world's 28 maritime chokepoints
// (2026-09-22). IMF PortWatch has been fetched by this app since
// 2026-09-08, but only ever as "today's snapshot, displayed raw" — see
// src/lib/sources/portwatch.ts's own header, which says outright that a
// meaningful read needs each chokepoint compared against its own
// baseline, and that no history was being kept to build one from.
//
// This is that history. Unlike every other snapshot table here, it did
// NOT have to start from empty: the PortWatch FeatureServer carries daily
// rows back to 2019-01-01 (78,960 of them, verified live), so the
// baseline was backfilled on day one and the signal was live immediately
// rather than after a 14-day wait.
//
// `snapshotDate` is a calendar day (YYYY-MM-DD text, the same shape
// country_feature_daily uses, and exactly what PortWatch's dateOnly field
// serializes to) and is unique per chokepoint: PortWatch publishes one
// row per chokepoint per day and revises recent days as new satellite AIS
// arrives, so a re-fetch must overwrite the day rather than append a
// second row for it — every other history table here appends, because its
// source has no notion of revising yesterday. Retention is bounded — see
// CHOKEPOINT_RETENTION_DAYS in src/lib/chokepointHistory.ts — because
// this table would otherwise grow without limit against a 500 MB
// database for history no consumer reads.
export const chokepointTransitHistory = pgTable(
  "chokepoint_transit_history",
  {
    id: serial("id").primaryKey(),
    chokepoint: text("chokepoint").notNull(), // PortWatch `portname`, verbatim
    snapshotDate: text("snapshot_date").notNull(), // YYYY-MM-DD (UTC)
    totalVessels: integer("total_vessels").notNull(),
    cargoVessels: integer("cargo_vessels").notNull(),
    tankerVessels: integer("tanker_vessels").notNull(),
  },
  (table) => [
    index("chokepoint_transit_history_date_idx").on(table.snapshotDate),
    unique("chokepoint_transit_history_point_date_key").on(table.chokepoint, table.snapshotDate),
  ],
);

export type ChokepointTransitHistoryRow = typeof chokepointTransitHistory.$inferSelect;
export type NewChokepointTransitHistoryRow = typeof chokepointTransitHistory.$inferInsert;

// Current membership of each sanctions list (2026-09-22). Deliberately
// just (list, entry_id) for ~25,600 rows: membership is all the weekly
// diff needs, and mirroring someone else's database — names, aliases,
// addresses, dates of birth — would cost tens of megabytes of a 500 MB
// budget to store a copy of a file that is public and re-downloadable.
// Everything descriptive lives on the delta rows below, where it
// documents one change at one time and stays true afterwards.
export const sanctionsEntry = pgTable(
  "sanctions_entry",
  {
    id: serial("id").primaryKey(),
    list: text("list").notNull(), // "ofac" | "eu"
    entryId: text("entry_id").notNull(), // the publisher's own permanent id
  },
  (table) => [unique("sanctions_entry_list_entry_key").on(table.list, table.entryId)],
);

export type SanctionsEntryRow = typeof sanctionsEntry.$inferSelect;
export type NewSanctionsEntryRow = typeof sanctionsEntry.$inferInsert;

// What changed between two fetches of a sanctions list. Neither OFAC nor
// the EU publishes a change feed, so this table IS the feed — and it is
// the durable record: the row keeps the name and programme as they read
// at the moment of the change, so a later revision upstream cannot
// silently rewrite history here.
//
// `country` is the programme's country where the programme names one
// (OFAC "IRAN-EO13902", EU "IRN") and null where it is thematic (OFAC
// "SDGT", EU "TERR"). Null is the honest answer there: a global terrorism
// designation is not a signal about any one country, and forcing it onto
// the designating state would be worse than leaving it blank.
//
// `name` is null on removals — the entry is gone from the published file,
// so there is nothing to read a name from, and the membership table does
// not keep one. See src/lib/sanctions.ts.
export const sanctionsDelta = pgTable(
  "sanctions_delta",
  {
    id: serial("id").primaryKey(),
    list: text("list").notNull(),
    entryId: text("entry_id").notNull(),
    change: text("change").notNull(), // "added" | "removed"
    name: text("name"),
    entityType: text("entity_type"), // person | entity | vessel | aircraft
    program: text("program"),
    country: text("country"), // ISO2, nullable
    publishedAt: text("published_at"), // YYYY-MM-DD when the list states one
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sanctions_delta_detected_at_idx").on(table.detectedAt),
    index("sanctions_delta_country_idx").on(table.country),
  ],
);

export type SanctionsDeltaRow = typeof sanctionsDelta.$inferSelect;
export type NewSanctionsDeltaRow = typeof sanctionsDelta.$inferInsert;

// What the alert engine saw for each country the last time it looked
// (2026-09-22). The engine needs a "since when" to say anything changed,
// and country_state_history cannot be it: that table is written once a
// day and the Trends tab charts it, whereas alerts are evaluated after
// every review cycle. One row per country, upserted — ~200 rows total.
export const alertCountryState = pgTable("alert_country_state", {
  country: text("country").primaryKey(),
  level: smallint("level").notNull(),
  momentum: smallint("momentum").notNull(),
  // The third state variable the change gate reads, alongside level and
  // momentum — a country picking up a new unusual signal is news even
  // when its score has not moved.
  anomalySignals: smallint("anomaly_signals").notNull().default(0),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AlertCountryStateRow = typeof alertCountryState.$inferSelect;
export type NewAlertCountryStateRow = typeof alertCountryState.$inferInsert;

// One row per alert the engine fired (2026-09-22) — the product's first
// push surface, and its own audit trail.
//
// Every INPUT to the decision is stored beside the verdict, not just the
// verdict: level and previous level, momentum and previous momentum, max
// severity, independent source families, anomaly signals, active pillars,
// the score, and the individual scoring components as JSON. That is the
// whole point. An alert nobody can reconstruct six months later is an
// opinion; this one can be recomputed from its own row by
// src/lib/alertScoring.ts's pure `assessAlert` and must land on the same
// tier, which is exactly what the regression tests assert.
//
// `suppressedReason` is set on rows the cooldown held back. They are
// still written, because "we saw this and chose not to push it" is
// evidence too — and because a suppressed-alert rate that creeps upward
// is how you find out a threshold needs tuning.
export const alerts = pgTable(
  "alerts",
  {
    id: serial("id").primaryKey(),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(),
    tier: text("tier").notNull(), // FLASH | PRIORITY | WATCH | ROUTINE
    country: text("country").notNull(),
    score: integer("score").notNull(),
    headline: text("headline").notNull(),
    level: smallint("level").notNull(),
    previousLevel: smallint("previous_level").notNull(),
    momentum: smallint("momentum").notNull(),
    previousMomentum: smallint("previous_momentum").notNull(),
    maxSeverity: smallint("max_severity").notNull(),
    sourceFamilies: smallint("source_families").notNull(),
    anomalySignals: smallint("anomaly_signals").notNull(),
    pillarsActive: smallint("pillars_active").notNull(),
    // JSON: [{ name, points, detail }] — the scoring breakdown as shown.
    components: text("components").notNull(),
    // JSON: [{ id, title, url, source, severity }] — the events that drove
    // it, so an alert always arrives with its evidence attached.
    evidence: text("evidence").notNull(),
    suppressedReason: text("suppressed_reason"),
  },
  (table) => [
    index("alerts_fired_at_idx").on(table.firedAt),
    index("alerts_country_idx").on(table.country),
    index("alerts_tier_idx").on(table.tier),
  ],
);

export type AlertRow = typeof alerts.$inferSelect;
export type NewAlertRow = typeof alerts.$inferInsert;

// GeoNames settlements over 15,000 people (2026-09-22) — the reference
// data the exposure model counts against, so a hazard's severity can be
// weighted by whether anyone lives where it happened. 34,146 rows, ~3 MB.
//
// Static reference data, not a feed: settlements do not move and their
// populations change on a scale of years, so nothing schedules a refresh
// (see loadPopulationCentersFromSource in src/lib/exposure.ts). Licensed
// CC BY 4.0 — attribution recorded in docs/API_SOURCES.md.
export const populationCenter = pgTable(
  "population_center",
  {
    geonameId: integer("geoname_id").primaryKey(),
    name: text("name").notNull(),
    country: text("country").notNull(), // ISO2
    lat: doublePrecision("lat").notNull(),
    lon: doublePrecision("lon").notNull(),
    population: integer("population").notNull(),
  },
  // No lat/lon index: exposure.ts only ever reads this table whole.
);

export type PopulationCenterRow = typeof populationCenter.$inferSelect;
export type NewPopulationCenterRow = typeof populationCenter.$inferInsert;

// Project 1 (2026-09-09, user request for "real ML" beyond linear
// regression): unsupervised clustering over feed_archive's existing
// embeddings (src/lib/narrativeClustering.ts's spherical k-means), read as
// "the latest generation of clusters" the same way anomalyFindings is read
// above — a weekly training run picks one `trainedAt` and every cluster
// from that run shares it, so "the current cluster map" is always
// `WHERE trainedAt = (SELECT MAX(trainedAt) FROM narrative_clusters)`, not
// a time window (a fresh weekly re-fit fully replaces the map, it doesn't
// merge with the previous one).
export const narrativeClusters = pgTable(
  "narrative_clusters",
  {
    id: serial("id").primaryKey(),
    trainedAt: timestamp("trained_at", { withTimezone: true }).notNull(),
    centroid: vector("centroid", { dimensions: 768 }).notNull(),
    memberCount: integer("member_count").notNull(),
    // The "still genuinely belongs to this cluster" boundary — the 95th
    // percentile of this cluster's own member-to-centroid cosine distances
    // at training time (see narrativeClustering.ts's chooseBestK/
    // silhouetteScore for the clustering itself; this threshold is
    // computed once per cluster right after fitting). A later item whose
    // nearest-centroid distance exceeds ITS OWN nearest cluster's
    // threshold reads as novel — a real development this app hasn't seen
    // the shape of before, not just "somewhat different."
    noveltyThreshold: doublePrecision("novelty_threshold").notNull(),
  },
  (table) => [index("narrative_clusters_trained_at_idx").on(table.trainedAt)],
);

export type NarrativeClusterRow = typeof narrativeClusters.$inferSelect;
export type NewNarrativeClusterRow = typeof narrativeClusters.$inferInsert;

// One row per feed_archive item ever scored against a cluster map — a
// PERMANENT record (unique on feedArchiveId, never re-scored on a later
// training run) of "was this novel relative to what this app had seen as
// of the week it arrived," not a snapshot that changes meaning depending
// on which week's cluster map you happen to check it against.
export const narrativeNoveltyFindings = pgTable(
  "narrative_novelty_findings",
  {
    id: serial("id").primaryKey(),
    feedArchiveId: integer("feed_archive_id").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    outcome: text("outcome").notNull(), // "novel" | "matched-cluster"
    nearestClusterId: integer("nearest_cluster_id"),
    distance: doublePrecision("distance"),
  },
  (table) => [
    index("narrative_novelty_findings_detected_at_idx").on(table.detectedAt),
    unique("narrative_novelty_findings_feed_archive_id_key").on(table.feedArchiveId),
  ],
);

export type NarrativeNoveltyFindingRow = typeof narrativeNoveltyFindings.$inferSelect;
export type NewNarrativeNoveltyFindingRow = typeof narrativeNoveltyFindings.$inferInsert;

// Project 3 (2026-09-09, "real ML" text classifier) — one row per weekly
// training/backtest run (src/lib/textClassifierTraining.ts). Shadow-mode
// only, same as riskModelRuns: `promoted` records whether this run's
// k-NN classifier beat a coin flip on the doubly-vetted classifier_audit
// correction set, never anything this app actually acts on yet.
export const textClassifierRuns = pgTable("text_classifier_runs", {
  id: serial("id").primaryKey(),
  trainedAt: timestamp("trained_at", { withTimezone: true }).notNull(),
  k: integer("k").notNull(),
  sampleSize: integer("sample_size").notNull(),
  cvAccuracy: doublePrecision("cv_accuracy").notNull(),
  backtestSampleSize: integer("backtest_sample_size").notNull(),
  backtestAgreementRate: doublePrecision("backtest_agreement_rate").notNull(),
  promoted: boolean("promoted").notNull().default(false),
  notes: text("notes"),
});

export type TextClassifierRunRow = typeof textClassifierRuns.$inferSelect;
export type NewTextClassifierRunRow = typeof textClassifierRuns.$inferInsert;

// Output of the daily anomaly scan (src/lib/anomalyScan.ts) — one table,
// a `signalType` discriminator column, same idiom as classifierAudit's
// `kind` column below rather than one table per signal.
//
// This table is read as "the latest generation of findings," not as a
// time series the way every table above it is — a scan run sets ONE
// detectedAt timestamp at its start and reuses it for every row that run
// inserts, so "current findings" is always
// `WHERE detectedAt = (SELECT MAX(detectedAt) FROM anomaly_findings)`,
// never a time window. A window would be unsafe here: this table has no
// idempotency guard (a manually re-triggered or double-fired scan just
// inserts again, matching every other snapshot table's existing posture),
// so two runs within a naive window would leave overlapping — possibly
// contradictory — generations of findings with no way to prefer one.
export const anomalyFindings = pgTable(
  "anomaly_findings",
  {
    id: serial("id").primaryKey(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    signalType: text("signal_type").notNull(),
    country: text("country").notNull(),
    // Only set for the event-volume-per-category signal; null for every
    // country-level-only signal (aircraft, GPS jamming, all-category
    // event volume).
    category: text("category"),
    // Nullable since 2026-09-09 (Project 2, country-state-multivariate
    // signal): observedValue/baselineMean/baselineStdDev are a SCALAR
    // baseline, meaningful for every original z-score signal but not for a
    // multivariate one (whose baseline is a mean VECTOR and covariance
    // MATRIX, not a single number) — forcing a vector into a scalar column
    // would corrupt what these columns mean for every reader, so the
    // multivariate signal simply leaves them null and stores its own
    // richer shape in `details` instead. zScore is NOT nullable and IS
    // populated by both: for the multivariate signal it holds the
    // Mahalanobis distance, which is genuinely the same conceptual role
    // (how many standard-deviation-equivalents away from baseline) even
    // though the underlying math differs.
    observedValue: doublePrecision("observed_value"),
    baselineMean: doublePrecision("baseline_mean"),
    baselineStdDev: doublePrecision("baseline_std_dev"),
    sampleSize: integer("sample_size").notNull(),
    // Nullable for the same reason as observedValue above — "jump" (a
    // signed scalar delta) has no single-number equivalent for a
    // multivariate baseline; see `details` for the actual per-feature
    // deltas instead.
    jump: doublePrecision("jump"),
    zScore: doublePrecision("z_score").notNull(),
    // JSON, only populated by the multivariate signal: {features: string[],
    // observedVector: number[], meanVector: number[], perFeatureZScore:
    // number[], shrinkageIntensity: number} — see
    // src/lib/multivariateAnomaly.ts's MultivariateBaselineResult. Makes a
    // multivariate finding interpretable (which features actually drove
    // it) without forcing that shape into the scalar columns above.
    details: text("details"),
  },
  (table) => [
    index("anomaly_findings_detected_at_idx").on(table.detectedAt),
    index("anomaly_findings_country_idx").on(table.country),
    index("anomaly_findings_signal_type_idx").on(table.signalType),
  ],
);

export type AnomalyFindingRow = typeof anomalyFindings.$inferSelect;
export type NewAnomalyFindingRow = typeof anomalyFindings.$inferInsert;

// One row per UTC day this app has called the Google Cloud Translation
// API — see src/lib/translationUsage.ts. This is what lets
// translateBatch enforce a hard monthly character cap across serverless
// invocations that share no in-memory state: the cap only means anything
// if usage is durable, not counted per cold start.
export const translationUsage = pgTable("translation_usage", {
  date: text("date").primaryKey(), // "YYYY-MM-DD", UTC
  characters: integer("characters").notNull().default(0),
});

export type TranslationUsageRow = typeof translationUsage.$inferSelect;

// Every candidate item the classifier evaluates (GDELT/RSS after the
// topical isLikelyGeopolitical filter, Telegram posts after translation)
// — kept AND dropped — archived here regardless of outcome. Separate from
// `events`, which only ever holds what actually became feed-visible: this
// table is never read by the website, only by
// /api/admin/vocabulary-report (see src/lib/classificationArchive.ts). The
// point is a growing, real dataset of what assessIncidentSeverity is
// currently rejecting, so new incident vocabulary can be found and added
// with real evidence behind it — the same discipline every vocabulary
// change already goes through in src/lib/classify.ts's comments, just
// automated instead of a one-off live-test each time. Deliberately does
// NOT feed back into classify.ts automatically — see the doc comment on
// GET in the vocabulary-report route for why that boundary is intentional.
export const classificationArchive = pgTable(
  "classification_archive",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(),
    url: text("url").notNull().unique(),
    title: text("title").notNull(),
    snippet: text("snippet").notNull(),
    kept: boolean("kept").notNull(),
    // Always computable via assessIncidentSeverity regardless of outcome.
    severity: integer("severity").notNull(),
    // Only set when kept=true — classifyByKeywords computes category as
    // part of the same pass that decides inclusion; dropped items never
    // reach that step, and re-deriving it just for archival isn't worth
    // the duplicated logic for what this table is actually used for
    // (vocabulary discovery cares about severity/text, not category).
    category: text("category"),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Set by src/lib/classifierAudit.ts once an item has gone through a
    // Gemini audit pass, whether or not that pass produced any finding —
    // classifier_audit only ever holds real findings (see its own doc
    // comment), so "no row there" can't distinguish "never checked" from
    // "checked and found correct." Without this column, an item Gemini
    // correctly declined to flag would get resubmitted for audit every
    // single day forever.
    auditedAt: timestamp("audited_at", { withTimezone: true }),
    // Project 3 (2026-09-09, "real ML" text classifier) — same Gemini
    // embedding model/column shape as feed_archive.embedding, but a
    // SEPARATE backfill is needed: feed_archive only ever holds rows that
    // were actually KEPT (inserted into events), so the ~2:1 majority of
    // this table (kept=false, the negative-label pool a relevance
    // classifier needs) has no embedding anywhere else to reuse.
    // `halfvec` since 2026-09-22 — see the type's own comment above.
    embedding: halfvec("embedding", { dimensions: 768 }),
  },
  (table) => [
    index("classification_archive_kept_idx").on(table.kept),
    index("classification_archive_archived_at_idx").on(table.archivedAt),
    index("classification_archive_audited_at_idx").on(table.auditedAt),
  ],
);

export type ClassificationArchiveRow = typeof classificationArchive.$inferSelect;
export type NewClassificationArchiveRow = typeof classificationArchive.$inferInsert;

// A non-English Telegram post that couldn't be translated this ingest
// cycle — today's byte budget was already spent, or the Translate API call
// itself failed — parked here instead of being silently dropped. See
// src/lib/pendingTranslation.ts: a post either gets translated the cycle
// it's discovered, using that day's live budget, or it sits here (2026-09-10,
// user request — no more automatic drain, no more time-based expiry;
// removed only once it resolves some other way, or by a future decision).
export const pendingTranslation = pgTable(
  "pending_translation",
  {
    id: serial("id").primaryKey(),
    url: text("url").notNull().unique(),
    // Full channel config (language/category/country/label) is looked up
    // fresh from TELEGRAM_CHANNELS by handle at drain time rather than
    // duplicated here, so it can't go stale relative to that list.
    handle: text("handle").notNull(),
    excerpt: text("excerpt").notNull(), // original-language excerpt, already sanitized
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    discoveredAt: timestamp("discovered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("pending_translation_discovered_at_idx").on(table.discoveredAt),
  ],
);

export type PendingTranslationRow = typeof pendingTranslation.$inferSelect;

// 2026-09-10 (user-caught bug): GDELT bulk items were being displayed with
// a title synthesized from GDELT's own structured CAMEO fields (actor names
// + a templated action verb), NOT the real headline of the article at
// `url` — so clicking through to the source showed a completely different,
// real story than what the card claimed. Same "queue now, do the real work
// on a later cycle" shape as pendingTranslation above (see
// src/lib/pendingGdeltTitle.ts and gdeltBulk.ts's drainPendingGdeltTitles):
// a candidate that clears GDELT's own structural filters (real actor
// affiliation, resolved country) gets queued here rather than published
// immediately, and only becomes a real feed candidate once a real title
// has actually been fetched from its own source page — never a synthesized
// guess. `resolvedCountry` and `publishedAt` are the only fields carried
// over from the CAMEO row; the actor/root-code/goldstein details that used
// to drive the synthesized description are deliberately NOT stored here —
// nothing downstream needs them once the real title takes over both
// display and classification.
export const pendingGdeltTitle = pgTable(
  "pending_gdelt_title",
  {
    id: serial("id").primaryKey(),
    url: text("url").notNull().unique(),
    resolvedCountry: text("resolved_country").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    discoveredAt: timestamp("discovered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Set when the title was fetched and the item handed to ingest. The
    // row then stays until discovered_at expiry, so UNIQUE(url) keeps the
    // overlapping discovery window (gdeltBulk.ts) from queueing it again.
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [index("pending_gdelt_title_discovered_at_idx").on(table.discoveredAt)],
);

export type PendingGdeltTitleRow = typeof pendingGdeltTitle.$inferSelect;
export type NewPendingGdeltTitleRow = typeof pendingGdeltTitle.$inferInsert;
export type NewPendingTranslationRow = typeof pendingTranslation.$inferInsert;

// Durable copy of every item that ever actually made it into `events` —
// across every source kind (RSS, GDELT, Telegram, USGS, EONET, GDACS,
// IODA, FIRMS) — for future ML trend/anomaly work over a country's risk
// history (see src/lib/feedArchive.ts, and country_state_history above
// for the pulse-score-over-time half of that same goal). Deliberately not
// scoped down to just each story's primary report the way the live feed
// display is: a duplicate report of the same real-world story from a
// second outlet is itself a signal (more outlets covering something is
// meaningful), so this keeps every row `events` gets, primary or not.
// User decision (2026-09-05): keep this table unpruned — no retention
// job — since the whole point is enough history to see multi-week trend
// shifts; revisit only if storage actually becomes a real constraint.
export const feedArchive = pgTable(
  "feed_archive",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(),
    url: text("url").notNull().unique(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    category: text("category").notNull(),
    country: text("country"), // ISO 3166-1 alpha-2, nullable — some direct/institutional sources don't resolve one
    lat: doublePrecision("lat").notNull(),
    lon: doublePrecision("lon").notNull(),
    severity: smallint("severity").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Nullable, populated asynchronously by src/lib/embeddingBackfill.ts —
    // never blocks the ingest path that writes this row (see
    // src/lib/feedArchive.ts's "must never fail or slow down live ingest"
    // rule, which this follows the same way). Semantic vector over
    // title+summary; the vector-similarity search this enables (see GET
    // /api/events/[id]/similar) is scoped to this table rather than
    // `events` because feed_archive is the durable full corpus (including
    // rows that have since aged out of events' 30-day window or were
    // folded in as a cross-outlet duplicate), and computing/storing the
    // embedding once here avoids doing it twice for the same content.
    // `halfvec` since 2026-09-22 — see the type's own comment above.
    embedding: halfvec("embedding", { dimensions: 768 }),
  },
  (table) => [
    index("feed_archive_country_idx").on(table.country),
    index("feed_archive_source_idx").on(table.source),
    index("feed_archive_published_at_idx").on(table.publishedAt),
  ],
);

export type FeedArchiveRow = typeof feedArchive.$inferSelect;
export type NewFeedArchiveRow = typeof feedArchive.$inferInsert;

// Local cache of MBFC's (Media Bias/Fact Check) domain-level credibility
// database (2026-09-11, user request — deterministic source-credibility
// gating for GDELT, replacing Gemini's own judgment-call version of the
// same thing). MBFC's own RapidAPI listing is HARD-CAPPED at 3 requests
// per month total (confirmed live against the real subscribed plan), but
// its one endpoint (GET /fetch-data, no params at all) returns the
// ENTIRE ~11,000+ source database in a single call — so this is a bulk
// sync-then-cache-locally table, never a live per-classification lookup.
// See src/lib/sourceCredibility.ts for the sync logic; classify.ts reads
// this table (via an in-memory map loaded once per ingest cycle, not a
// DB round-trip per item) to gate gdelt sources deterministically.
//
// Real schema confirmed via the first live sync (2026-09-11) — MBFC's
// actual JSON keys are "Source", "Source URL", "Bias", "Political Bias",
// "Factual Reporting", "Credibility", "Country", "Media Type". `bias`
// below maps to their "Bias" field specifically, NOT "Political Bias" —
// this is the more useful one for gating: its values are a mix of
// ordinary political-lean labels (Left/Left-Center/Least Biased/Right-
// Center/Right/Pro-Science) AND MBFC's own special disqualifying
// categories (Questionable, Conspiracy-Pseudoscience, Satire) in the
// SAME field — e.g. Xinhua/Sputnik/Press TV/Breitbart all show
// bias="Questionable" alongside credibility="Low", while Daily Caller
// (politically right-leaning but not disqualified) shows bias="Right"
// and credibility="Medium" — confirming this is a real quality signal,
// not just a political-lean penalty. `politicalBias` holds their
// separate, more granular left/right spectrum field for context/display.
export const sourceCredibility = pgTable(
  "source_credibility",
  {
    id: serial("id").primaryKey(),
    // Hostname, lowercased, no "www." — same normalization as
    // classifierAudit.ts's extractDomain, so a lookup never misses on a
    // formatting mismatch between the two.
    domain: text("domain").notNull().unique(),
    name: text("name"),
    bias: text("bias"),
    politicalBias: text("political_bias"),
    factualRating: text("factual_rating"),
    credibility: text("credibility"),
    country: text("country"),
    mediaType: text("media_type"),
    // The raw MBFC record for this domain, JSON-stringified — kept
    // alongside the extracted columns above so a parsing mistake in this
    // table's own columns is recoverable without spending another one of
    // the 3 monthly calls to re-fetch.
    raw: text("raw"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // domain is UNIQUE, which already indexes it.
);

export type SourceCredibilityRow = typeof sourceCredibility.$inferSelect;
export type NewSourceCredibilityRow = typeof sourceCredibility.$inferInsert;

// Lightweight daily counter for Gemini API calls (embeddings now, country
// briefs next) — NOT a hard billing cap the way translation_usage is.
// Google Translate has no meaningful free tier, so translationUsage exists
// to stop a real bill. Gemini's free tier has zero cost as long as no
// billing account is linked to the project — exceeding it just gets a
// 429, which embedBatch/backfillFeedArchiveEmbeddings already treat as a
// soft failure to retry next cycle (same shape as translateBatch's null
// return). This table exists purely for visibility (see
// GET /api/admin/ai-usage) — "is this actually running, and how much" —
// not to enforce a limit.
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: serial("id").primaryKey(),
    // "YYYY-MM-DD" — Pacific calendar day (see aiUsage.ts's todayPacific),
    // matching Google's own Gemini/AI Studio RPD reset clock, not UTC.
    // Rows written before 2026-09-10 were keyed on UTC instead; left as
    // historical artifacts under the old scheme rather than migrated —
    // this table is observability/pacing, not a ledger that needs to
    // reconcile perfectly across the switchover.
    date: text("date").notNull(),
    kind: text("kind").notNull(), // "embedding" | "brief" | "audit" | "geocode"
    count: integer("count").notNull().default(0),
  },
  (table) => [unique("ai_usage_date_kind_unique").on(table.date, table.kind)],
);

export type AiUsageRow = typeof aiUsage.$inferSelect;

// One row per country per generation — see src/lib/countryBriefs.ts. Kept
// as full history rather than upserted-latest-only, same "keep everything,
// storage is cheap" call the user made for feed_archive (2026-09-05) —
// small text rows, and it's the substrate for a future "how has our
// assessment of this country changed" view, not just today's snapshot.
// The UI (CountryRiskPanel) only ever reads the most recent row per
// country though — see getLatestCountryBrief.
export const countryBriefs = pgTable(
  "country_briefs",
  {
    id: serial("id").primaryKey(),
    country: text("country").notNull(),
    briefText: text("brief_text").notNull(),
    // How many events the prompt was actually grounded in — shown in the
    // UI next to the brief so it never reads as more authoritative than
    // "an LLM read N recent headlines," which is all it is.
    eventCount: integer("event_count").notNull(),
    model: text("model").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("country_briefs_country_idx").on(table.country),
    index("country_briefs_generated_at_idx").on(table.generatedAt),
  ],
);

export type CountryBriefRow = typeof countryBriefs.$inferSelect;

// Findings from src/lib/classifierAudit.ts's daily Gemini pass over
// classification_archive — the AI-assisted successor to
// /api/admin/vocabulary-report's pure word-frequency approach, same
// non-negotiable boundary that route's own doc comment already
// establishes: this NEVER writes back into classify.ts automatically.
// Editorial judgment for a product whose premise is being defensible to
// a skeptical reader doesn't survive full automation, and an LLM auditor
// specifically adds a new manipulation surface a frequency count never
// had — a malicious article's body text could contain actual prompt-
// injection content aimed at the auditor. Every row here is a proposal
// a human reviews (see GET /api/admin/classifier-audit and its /review
// sub-route) before anything in classify.ts changes, same discipline
// every real vocabulary change already goes through — that boundary is
// absolute and unrelated to the one below.
// A narrower, separate exception (2026-09-10): a false_negative row can
// auto-apply — recovering that ONE article into the live feed, nothing in
// classify.ts — without waiting for human/Claude review, but only when
// backed by independent, deterministic, non-LLM corroboration (see
// corroboratedCountry in classifierAudit.ts). Gemini's own read is never
// by itself sufficient for that; anything it flags without that backing
// still lands here as a plain pending row for review exactly as before.
// One row per (archive item, finding kind) — a row is only ever created
// when Gemini actually flags something, not one row per item considered,
// so this table's size reflects genuine findings, not audit volume. A
// single article can carry more than one finding at once (e.g. correctly
// included but with the wrong severity AND the wrong country), hence the
// unique constraint is on (archiveId, kind) rather than archiveId alone.
export const classifierAudit = pgTable(
  "classifier_audit",
  {
    id: serial("id").primaryKey(),
    archiveId: integer("archive_id").notNull(),
    // "false_positive" | "false_negative" | "severity_mismatch" | "country_mismatch"
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    // Nullable — added after the first live run; those first rows predate
    // url/publishedAt tracking and can't be auto-applied (see
    // applyFinding in classifierAudit.ts), only re-reviewed manually.
    url: text("url"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    title: text("title").notNull(),
    snippet: text("snippet").notNull(),
    severity: integer("severity").notNull(),
    reasoning: text("reasoning").notNull(),
    // Only ever set for false_negative findings — Gemini's hypothesis for
    // which specific word/phrase/pattern the keyword classifier is
    // missing, the actual "fine-tuning fuel" a human turns into a real
    // classify.ts change.
    suggestedFix: text("suggested_fix"),
    // Set for false_negative (recovery severity — the archived severity
    // is often exactly why the item was excluded, e.g. a benign-pattern
    // hit falls back to 1) and severity_mismatch findings (Gemini's
    // independent 1-5 read vs. what's currently live).
    suggestedSeverity: integer("suggested_severity"),
    // Set for false_negative (recovery country) and country_mismatch
    // findings — Gemini's independent judgment of which ISO 3166-1
    // alpha-2 country is actually at risk/affected, vs. the country
    // resolveCountryFromText's earliest-mention heuristic picked (the
    // same bug class as the 2026-09-08 Oman fix, just caught by reading
    // comprehension instead of a regex fix).
    suggestedCountry: text("suggested_country"),
    status: text("status").notNull().default("pending"), // pending | approved | rejected | applied
    reviewNote: text("review_note"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("classifier_audit_status_idx").on(table.status),
    index("classifier_audit_created_at_idx").on(table.createdAt),
    unique("classifier_audit_archive_kind_unique").on(table.archiveId, table.kind),
  ],
);

export type ClassifierAuditRow = typeof classifierAudit.$inferSelect;

// The recursive-learning half of classifierAudit.ts: findings above are
// per-article, one-shot corrections; a row here is a GENERALIZED lesson
// distilled from one or more of those reviews — a pattern Gemini keeps
// getting wrong (or a rubric refinement) that gets fed back into every
// future audit prompt (see calibration-lesson injection in
// buildKeptAuditPrompt/buildFalseNegativePrompt), not just applied to the
// one live event that surfaced it. Recorded by the reviewer (Claude) via
// reviewAuditFinding's optional `lesson` param at the moment a finding is
// approved/rejected — same manipulation-surface boundary as classifier_audit
// itself (a human/Claude writes it, never Gemini directly), it just closes
// the loop one level up: today, DELIBERATE_EXCLUSIONS/SEVERITY_RUBRIC/
// COUNTRY_GUIDANCE in classifierAudit.ts only grow when Claude notices a
// pattern AND happens to hand-edit + redeploy code; this table lets a
// lesson go live in the very next audit call instead, no deploy required.
// `pattern` is a stable slug (not free text) specifically so a recurring
// mistake reinforces the SAME row (upsert-by-pattern, incrementing
// `occurrences`) rather than accumulating near-duplicate lessons that bloat
// the prompt over time.
// A lesson reaches this table (and starts influencing every future audit
// prompt) two ways: a human/Claude reviewer calling reviewAuditFinding with
// a `lesson` param (the original 2026-09-08 design), or — as of 2026-09-10 —
// autonomously, once classifierCalibrationEvidence below shows the same
// pattern independently corroborated across distinct sources/articles/time.
// Both paths write through the same recordCalibrationLesson upsert; this
// table doesn't know or care which one triggered a given row.
export const classifierCalibration = pgTable(
  "classifier_calibration",
  {
    id: serial("id").primaryKey(),
    pattern: text("pattern").notNull().unique(),
    lesson: text("lesson").notNull(),
    // "kept" | "dropped" | "both" — which audit prompt(s) this lesson is
    // relevant to; a false_negative-derived lesson about a missed keyword
    // has nothing to say to the kept-item severity/country prompt, and
    // vice versa.
    appliesTo: text("applies_to").notNull().default("both"),
    // How many separate review decisions have reinforced this exact
    // pattern — a lesson recorded once might be a fluke; one recorded
    // repeatedly is a genuine recurring miscalibration, worth eventually
    // graduating into the hand-maintained prompt constants themselves.
    occurrences: integer("occurrences").notNull().default(1),
    // Soft-delete, not a hard delete — an active lesson that turns out to
    // be wrong (or gets superseded/generalized by a later one) is
    // deactivated so the provenance stays queryable, same posture as
    // classifier_audit's own status field never deleting a finding.
    active: boolean("active").notNull().default(true),
    // Provenance — the classifier_audit.id whose review produced this
    // lesson, if any (nullable: a lesson can also be recorded directly,
    // not just distilled from one specific finding).
    sourceFindingId: integer("source_finding_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastReinforcedAt: timestamp("last_reinforced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("classifier_calibration_active_idx").on(table.active)],
);

// The autonomous half of the calibration loop (2026-09-10 user request:
// "make the learning actually recursive and not need a human"). Gemini may
// now propose a `pattern`+`lesson` on any finding it flags (see
// buildKeptAuditPrompt/buildFalseNegativePrompt in classifierAudit.ts), but
// a single proposal is never trusted directly into classifierCalibration —
// that table's own doc comment (and classifier_audit's, above) already
// establishes why: an LLM auditor is itself a manipulation surface, and a
// hostile article's body text could contain prompt-injection content
// aimed at planting a self-serving "lesson" that then biases every future
// audit call reading it back. This table is the staging ground instead:
// one row per (pattern, archiveId) — the same article can't vote for the
// same pattern twice — and maybeAutoPromote in classifierAudit.ts only
// promotes a pattern into classifierCalibration once it's been
// independently proposed across multiple DISTINCT sources and articles,
// spread over a minimum time span (AUTO_PROMOTE_* constants). A single
// poisoned article can bias its own audit call, but it cannot make the
// same pattern slug organically reappear from unrelated outlets on
// unrelated days — that recurrence, not any one model's word, is what
// actually gets trusted, the identical philosophy corroboratedCountry
// already applies to false_negative auto-apply.
export const classifierCalibrationEvidence = pgTable(
  "classifier_calibration_evidence",
  {
    id: serial("id").primaryKey(),
    pattern: text("pattern").notNull(),
    // The most recently proposed wording for this pattern — the winning
    // promotion call uses whichever piece of evidence completes the bar,
    // not necessarily the first one proposed.
    lesson: text("lesson").notNull(),
    // "kept" | "dropped" only (never "both") — deterministically set from
    // which prompt produced this evidence, not read from Gemini's own
    // claim about its scope, so a proposal can't self-declare broader
    // reach than the one prompt it actually demonstrated a miss on.
    appliesTo: text("applies_to").notNull(),
    archiveId: integer("archive_id").notNull(),
    // The outlet this evidence came from — corroboration requires distinct
    // SOURCES, not just distinct articles, since a single compromised or
    // unusual outlet publishing several similar items shouldn't alone
    // manufacture "independent" corroboration.
    source: text("source").notNull(),
    // Provenance — the classifier_audit.id this evidence was attached to,
    // if any (auto-applied false_negative recoveries also contribute
    // evidence without necessarily having a durable finding row to point
    // back to in every case).
    findingId: integer("finding_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("classifier_calibration_evidence_pattern_archive_unique").on(table.pattern, table.archiveId),
    index("classifier_calibration_evidence_pattern_idx").on(table.pattern),
  ],
);

// Canonical registry of lesson patterns (2026-09-20). Before this, every
// piece of evidence carried whatever slug Gemini happened to invent that
// call — production had 908 evidence rows across 725 distinct patterns,
// three separately-promoted lessons that were the SAME "exclude Gaza"
// rule under three slugs, and five gdelt-noise slugs sharing 41 votes with
// none of them ever clearing the corroboration bar. This table makes the
// slug canonical: a new proposal is matched by exact slug first, then by
// cosine similarity of its lesson text against every stored embedding
// (see PATTERN_MERGE_MIN_SIMILARITY in classifierAudit.ts, chosen from a
// live similarity matrix of real lessons), and only becomes a new row if
// neither matches. Evidence is then recorded under the canonical slug.
//
// guardVerdict is the drift-guard's answer (see buildLessonGuardPrompt)
// — recorded once per pattern the first time it clears the corroboration
// bar, so a pattern judged to "widen" or "contradict" the foundational
// rules is never re-asked and never promoted, and a pattern that merely
// "restates" them never bloats the prompt. Null = not yet evaluated.
export const classifierCalibrationPatterns = pgTable(
  "classifier_calibration_patterns",
  {
    id: serial("id").primaryKey(),
    pattern: text("pattern").notNull().unique(),
    // Canonical wording: the first lesson text proposed under this
    // pattern. Later proposals that merge into it keep this wording (the
    // merge decision was made against it).
    lesson: text("lesson").notNull(),
    appliesTo: text("applies_to").notNull(),
    // Null when the embedding budget was exhausted at creation time —
    // such a row can still be matched by exact slug, just not by
    // similarity, until a later call backfills it.
    embedding: vector("embedding", { dimensions: 768 }),
    guardVerdict: text("guard_verdict"), // restates | narrows | widens | contradicts | new
    guardReasoning: text("guard_reasoning"),
    guardCheckedAt: timestamp("guard_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("classifier_calibration_patterns_pattern_idx").on(table.pattern)],
);

// The ground-truth channel for the pre-publish gate (2026-09-20). Until
// this existed, reviewPendingEvents made ~600 approve/reject decisions a
// day and nothing ever checked any of them against a human — the daily
// backlog audit re-judges Gemini's approvals with the same model and the
// same prompt, which measures self-agreement, not accuracy. A small daily
// sample (see sampleGateDecisions in gateReview.ts) lands here for a
// person to grade in a minute or two; the grades give a running
// precision/recall for the gate, flip the sampled event when the gate was
// wrong, and form the held-out evaluation set for the shadow k-NN
// classifier (textClassifierTraining.ts) — the "independent,
// representative evaluation with reviewer provenance" its own notes said
// it needed before it could ever be promoted.
export const gateReviewSamples = pgTable(
  "gate_review_samples",
  {
    id: serial("id").primaryKey(),
    eventId: integer("event_id").notNull().unique(),
    sampledAt: timestamp("sampled_at", { withTimezone: true }).notNull().defaultNow(),
    gateDecision: text("gate_decision").notNull(), // approved | rejected
    gateReasoning: text("gate_reasoning"),
    // Denormalised so the grading page needs no joins and the row stays
    // readable after the event ages out of the 30-day window.
    source: text("source").notNull(),
    url: text("url").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    country: text("country"),
    category: text("category").notNull(),
    severity: integer("severity").notNull(),
    humanVerdict: text("human_verdict"), // correct | wrong (null = ungraded)
    humanNote: text("human_note"),
    gradedAt: timestamp("graded_at", { withTimezone: true }),
  },
  (table) => [index("gate_review_samples_graded_at_idx").on(table.gradedAt)],
);

// Shadow-mode predictive risk model — see src/lib/riskModel.ts. Redesigned
// 2026-09-09 (same day as first shipped) per user request: predicts a
// country's actual future score over several horizons via linear
// regression, not a binary escalation flag via logistic regression — the
// original shape (positiveCount, backtest precision/recall) was dropped
// and recreated rather than migrated forward, since only 2 test rows
// existed and neither was real data.
//
// One row per (training run, horizon) — horizonDays distinguishes which
// of PREDICTION_HORIZONS_DAYS this row is; each horizon is trained,
// backtested, and promoted independently. Nothing reads `promoted` as
// "show this to users" yet — it only marks "the best validated run so
// far for this horizon" for internal bookkeeping. `modelParams` is one
// JSON blob (the whole LinearRegressionModel — weights, bias, feature/
// target standardization stats) rather than several parallel array
// columns — simpler once there's more than a couple pieces of fitted
// state to track, and a changed feature set still doesn't need a schema
// migration, same "don't build ahead of a consumer" reasoning ROADMAP.md
// already states for structural decisions elsewhere in this app.
export const riskModelRuns = pgTable("risk_model_runs", {
  id: serial("id").primaryKey(),
  trainedAt: timestamp("trained_at", { withTimezone: true }).notNull().defaultNow(),
  // Project 4 (2026-09-09, "real ML" challenger) — "linear-regression" |
  // "gradient-boosted-trees". Both model types train against the EXACT
  // SAME examples/split for a given horizon and get their own row here;
  // getLatestModelRun compares their backtest MAE and serves whichever
  // one actually wins, champion/challenger-style, rather than either
  // model type being hardcoded as "the" model.
  modelType: text("model_type").notNull().default("linear-regression"),
  horizonDays: integer("horizon_days").notNull(),
  sampleSize: integer("sample_size").notNull(),
  // Nullable — when sampleSize is too low to train at all (today's
  // reality: 0 eligible labeled examples for every horizon, since
  // training data now only starts 2026-09-09), there is no real fit to
  // record. Null here means exactly that, not a fabricated model that
  // would silently predict something meaningless.
  features: text("features"), // JSON string[]
  // JSON LinearRegressionModel or GbmModel, per `modelType` above.
  modelParams: text("model_params"),
  // Only ever set when modelType = "linear-regression" (the L2 strength
  // nested validation picked); null for gradient-boosted-trees runs, which
  // select (nEstimators, maxDepth) instead — see `notes` for those values,
  // not worth two more nullable columns only one model type ever uses.
  selectedL2: doublePrecision("selected_l2"),
  backtestSampleSize: integer("backtest_sample_size").notNull(),
  // Nullable, not a fabricated 0 — undefined when there was no backtest
  // split to evaluate at all.
  backtestMae: doublePrecision("backtest_mae"),
  backtestRmse: doublePrecision("backtest_rmse"),
  // The naive "predict no change from today's score" baseline's own MAE,
  // stored alongside the model's — promotion (see riskModel.ts) requires
  // genuinely beating this, not just producing a number.
  backtestNaiveMae: doublePrecision("backtest_naive_mae"),
  promoted: boolean("promoted").notNull().default(false),
  notes: text("notes"),
});

// Shadow predictions — one row per country per (training run, horizon),
// generated at train time from that horizon's own model, graded later
// once its own horizon's window actually resolves
// (src/lib/riskModelGrading.ts, run daily via /api/admin/snapshot). This
// IS the live calibration record: a genuinely out-of-sample,
// prospectively-graded track record, not just a historical backtest.
// modelRunId is a plain integer, not a Drizzle .references() FK — this
// schema has no precedent for that anywhere (primary_event_id's real FK
// constraint is added via raw SQL in the migrate route instead), so this
// follows that same established convention rather than introducing a new
// one for the first time here.
export const riskPredictions = pgTable(
  "risk_predictions",
  {
    id: serial("id").primaryKey(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    modelRunId: integer("model_run_id").notNull(),
    country: text("country").notNull(),
    predictedScore: doublePrecision("predicted_score").notNull(),
    // Derived from predictedScore via threat.ts's weightToThreatLevel —
    // the exact same function risk.ts uses everywhere else, so a
    // predicted Pulse Level is always consistent with how the app defines
    // Pulse Level, not a second independent notion of "level."
    predictedThreatLevel: smallint("predicted_threat_level").notNull(),
    inputFeatures: text("input_features").notNull(), // JSON number[]
    resolvesAt: timestamp("resolves_at", { withTimezone: true }).notNull(),
    // Both null = not yet graded. absoluteError is the primary grading
    // metric for a regression target — a boolean "was this right" would
    // throw away exactly the information a continuous score prediction
    // is supposed to carry.
    actualScore: doublePrecision("actual_score"),
    actualThreatLevel: smallint("actual_threat_level"),
    absoluteError: doublePrecision("absolute_error"),
    // Set with actualScore when graded, or alone when the prediction was
    // voided because the score methodology changed before it resolved.
    gradedAt: timestamp("graded_at", { withTimezone: true }),
    // The scoring methodology the input snapshot was computed under — a
    // prediction is only ever graded against an outcome of the same
    // version (src/lib/riskModelGrading.ts).
    scoringVersion: smallint("scoring_version").notNull(),
  },
  (table) => [
    index("risk_predictions_resolves_at_idx").on(table.resolvesAt),
    index("risk_predictions_country_idx").on(table.country),
    index("risk_predictions_model_run_id_idx").on(table.modelRunId),
  ],
);

export type RiskModelRunRow = typeof riskModelRuns.$inferSelect;
export type NewRiskModelRunRow = typeof riskModelRuns.$inferInsert;
export type RiskPredictionRow = typeof riskPredictions.$inferSelect;
export type NewRiskPredictionRow = typeof riskPredictions.$inferInsert;

export type ClassifierCalibrationRow = typeof classifierCalibration.$inferSelect;
export type ClassifierCalibrationEvidenceRow = typeof classifierCalibrationEvidence.$inferSelect;

// The model registry (2026-09-20, ML roadmap phase 1) — one row per
// training run of ANY model family, written best-effort by each trainer
// after its own run table. The family-specific tables (risk_model_runs,
// text_classifier_runs, narrative_clusters) keep the full detail; this is
// the one place that can answer "what models exist, which are promoted,
// and what did each score against its naive baseline" without knowing
// every family's schema — which is what the public /models page reads.
// A registry write failing never fails a trainer (see recordModelRun).
export const modelRegistry = pgTable(
  "model_registry",
  {
    id: serial("id").primaryKey(),
    trainedAt: timestamp("trained_at", { withTimezone: true }).notNull().defaultNow(),
    family: text("family").notNull(), // "risk-score-delta" | "text-classifier" | "narrative-clusters" | ...
    variant: text("variant").notNull(), // e.g. "linear-regression/1d", "knn/k=15", "kmeans/k=50"
    sampleSize: integer("sample_size").notNull(),
    backtestSampleSize: integer("backtest_sample_size").notNull().default(0),
    featureNames: text("feature_names"), // JSON string[]
    metrics: text("metrics").notNull(), // JSON object — the model's own held-out numbers
    baseline: text("baseline"), // JSON object — the naive alternative's numbers on the same held-out set
    trained: boolean("trained").notNull().default(true),
    promoted: boolean("promoted").notNull().default(false),
    notes: text("notes"),
    sourceTable: text("source_table"), // which family table holds the detail row
    sourceId: integer("source_id"),
  },
  (table) => [
    index("model_registry_family_idx").on(table.family),
    index("model_registry_trained_at_idx").on(table.trainedAt),
  ],
);

export type ModelRegistryRow = typeof modelRegistry.$inferSelect;
export type NewModelRegistryRow = typeof modelRegistry.$inferInsert;
