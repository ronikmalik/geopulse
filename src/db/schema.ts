import {
  pgTable,
  serial,
  text,
  doublePrecision,
  smallint,
  integer,
  timestamp,
  index,
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
