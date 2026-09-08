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
    // /api/stream, risk.ts, similarEvents.ts) until
    // reviewPendingEvents (classifierAudit.ts) promotes or rejects them,
    // almost always within the same or next ~15min ingest cycle. Direct
    // structural sources (USGS/EONET/GDACS/IODA/FIRMS) skip the gate
    // entirely — inserted "approved" — since there's no comparable
    // editorial judgment call in "a magnitude-6 earthquake happened at
    // these coordinates." A stale pending row past
    // PENDING_REVIEW_MAX_AGE_MS auto-promotes on the classifier's own
    // original verdict rather than staying invisible forever if Gemini
    // is ever unavailable — see reviewPendingEvents's own doc comment.
    // Existing rows were grandfathered to "approved" the moment this
    // column was added (see the migrate route) — this was never meant
    // to retroactively hide anything already live.
    reviewStatus: text("review_status").notNull().default("pending"),
  },
  (table) => [
    index("events_created_at_idx").on(table.createdAt),
    index("events_category_idx").on(table.category),
    index("events_country_idx").on(table.country),
    index("events_correlation_group_idx").on(table.correlationGroupId),
    index("events_primary_event_id_idx").on(table.primaryEventId),
    index("events_review_status_idx").on(table.reviewStatus),
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
    // Set by src/lib/classifierAudit.ts once an item has gone through a
    // Gemini audit pass, whether or not that pass produced any finding —
    // classifier_audit only ever holds real findings (see its own doc
    // comment), so "no row there" can't distinguish "never checked" from
    // "checked and found correct." Without this column, an item Gemini
    // correctly declined to flag would get resubmitted for audit every
    // single day forever.
    auditedAt: timestamp("audited_at", { withTimezone: true }),
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
// cycle — today's character budget was already spent, or the Translate
// API call itself failed — parked here instead of being silently dropped.
// See src/lib/pendingTranslation.ts: drained on a later cycle once budget
// frees up (or the API recovers), oldest first; rows that sit unprocessed
// past PENDING_TRANSLATION_MAX_AGE_MS are expired without ever being
// translated, since by then it's no longer "live breaking" content.
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
    embedding: vector("embedding", { dimensions: 768 }),
  },
  (table) => [
    index("feed_archive_country_idx").on(table.country),
    index("feed_archive_source_idx").on(table.source),
    index("feed_archive_published_at_idx").on(table.publishedAt),
  ],
);

export type FeedArchiveRow = typeof feedArchive.$inferSelect;
export type NewFeedArchiveRow = typeof feedArchive.$inferInsert;

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
    date: text("date").notNull(), // "YYYY-MM-DD", UTC
    kind: text("kind").notNull(), // "embedding" | "brief"
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
// every real vocabulary change already goes through.
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
