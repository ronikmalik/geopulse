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
} from "drizzle-orm/pg-core";

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
  },
  (table) => [
    index("events_created_at_idx").on(table.createdAt),
    index("events_category_idx").on(table.category),
    index("events_country_idx").on(table.country),
    index("events_correlation_group_idx").on(table.correlationGroupId),
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
  },
  (table) => [
    index("country_state_history_country_idx").on(table.country),
    index("country_state_history_snapshot_at_idx").on(table.snapshotAt),
  ],
);

export type CountryStateHistoryRow = typeof countryStateHistory.$inferSelect;
export type NewCountryStateHistoryRow = typeof countryStateHistory.$inferInsert;

// One row per country per daily snapshot of currently-tracked military
// aircraft (see src/lib/flightBaseline.ts and the /api/admin/snapshot-flights
// cron) — the same "record it now, judge it later" pattern as
// countryStateHistory above. There is no anomaly detection yet because
// there is no baseline yet; this table exists to build one honestly over a
// few weeks of real counts instead of shipping a surge threshold guessed
// with no data behind it. See docs/OSINT_SOURCES.md.
export const aircraftCountHistory = pgTable(
  "aircraft_count_history",
  {
    id: serial("id").primaryKey(),
    country: text("country").notNull(), // ISO 3166-1 alpha-2, reverse-geocoded from lat/lon
    snapshotAt: timestamp("snapshot_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    count: integer("count").notNull(),
  },
  (table) => [
    index("aircraft_count_history_country_idx").on(table.country),
    index("aircraft_count_history_snapshot_at_idx").on(table.snapshotAt),
  ],
);

export type AircraftCountHistoryRow = typeof aircraftCountHistory.$inferSelect;
export type NewAircraftCountHistoryRow = typeof aircraftCountHistory.$inferInsert;

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
  },
  (table) => [
    index("classification_archive_kept_idx").on(table.kept),
    index("classification_archive_archived_at_idx").on(table.archivedAt),
  ],
);

export type ClassificationArchiveRow = typeof classificationArchive.$inferSelect;
export type NewClassificationArchiveRow = typeof classificationArchive.$inferInsert;
