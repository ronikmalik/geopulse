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
    // EXCEPT gdelt (2026-09-10): that source's stale-pending rows are
    // deliberately excluded from auto-promotion and can stay "pending"
    // indefinitely until a real Gemini review reaches them — see
    // PENDING_REVIEW_MAX_AGE_MINUTES's doc comment in classifierAudit.ts.
    // /api/stream accounts for this specifically (a gdelt row can't block
    // its ordering cursor the way any other still-resolving-within-30min
    // source's pending row can); risk.ts/similarEvents.ts need no special
    // handling since they're stateless reads, not an incremental cursor.
    // Existing rows were grandfathered to "approved" the moment this
    // column was added (see the migrate route) — this was never meant
    // to retroactively hide anything already live.
    reviewStatus: text("review_status").notNull().default("pending"),
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
  },
  (table) => [
    index("events_created_at_idx").on(table.createdAt),
    index("events_category_idx").on(table.category),
    index("events_country_idx").on(table.country),
    index("events_correlation_group_idx").on(table.correlationGroupId),
    index("events_primary_event_id_idx").on(table.primaryEventId),
    index("events_review_status_idx").on(table.reviewStatus),
    index("events_geocoded_at_idx").on(table.geocodedAt),
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
  },
  (table) => [
    index("country_state_history_country_idx").on(table.country),
    index("country_state_history_snapshot_at_idx").on(table.snapshotAt),
  ],
);

export type CountryStateHistoryRow = typeof countryStateHistory.$inferSelect;
export type NewCountryStateHistoryRow = typeof countryStateHistory.$inferInsert;

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
    embedding: vector("embedding", { dimensions: 768 }),
    // Shadow-mode native-language classifier (2026-09-10, see
    // src/lib/nativeIncidentClassifier.ts) — only ever populated for
    // Telegram rows in a non-English channel where a REAL (translated)
    // kept/severity decision was also made this same row, so the two can
    // be compared. Both null means "no shadow opinion was run" (English
    // channel, or the language has no pattern set) — never treat null as
    // "shadow classifier said drop." This intentionally never feeds back
    // into `kept`/`severity` above; see that file's own doc comment for
    // why a straight cutover isn't safe yet.
    nativeKept: boolean("native_kept"),
    nativeSeverity: integer("native_severity"),
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
    gradedAt: timestamp("graded_at", { withTimezone: true }),
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
