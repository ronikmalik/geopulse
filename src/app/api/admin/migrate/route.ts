import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { isCronAuthorized } from "@/lib/cronAuth";

// There's no migration framework in this project (no local Node install to
// run drizzle-kit, and the Neon connection string isn't retrievable via
// the Vercel API even with decrypt=true — likely wrapped by the Vercel/Neon
// marketplace integration). This is the pragmatic substitute: a protected
// endpoint that applies the current desired schema via idempotent
// CREATE/ALTER ... IF NOT EXISTS statements, run once by hand after a
// schema change ships. Safe to hit repeatedly — every statement no-ops if
// already applied.
export const maxDuration = 55;

const STATEMENTS = [
  sql`CREATE TABLE IF NOT EXISTS country_state_history (
    id SERIAL PRIMARY KEY,
    country TEXT NOT NULL,
    snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    score DOUBLE PRECISION NOT NULL,
    threat_level SMALLINT NOT NULL,
    momentum SMALLINT NOT NULL,
    momentum_direction SMALLINT NOT NULL,
    event_count INTEGER NOT NULL
  )`,
  sql`CREATE INDEX IF NOT EXISTS country_state_history_country_idx ON country_state_history (country)`,
  sql`CREATE INDEX IF NOT EXISTS country_state_history_snapshot_at_idx ON country_state_history (snapshot_at)`,
  sql`CREATE TABLE IF NOT EXISTS aircraft_count_history (
    id SERIAL PRIMARY KEY,
    country TEXT NOT NULL,
    snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    count INTEGER NOT NULL
  )`,
  sql`CREATE INDEX IF NOT EXISTS aircraft_count_history_country_idx ON aircraft_count_history (country)`,
  sql`CREATE INDEX IF NOT EXISTS aircraft_count_history_snapshot_at_idx ON aircraft_count_history (snapshot_at)`,
  sql`CREATE TABLE IF NOT EXISTS translation_usage (
    date TEXT PRIMARY KEY,
    characters INTEGER NOT NULL DEFAULT 0
  )`,
  sql`CREATE TABLE IF NOT EXISTS classification_archive (
    id SERIAL PRIMARY KEY,
    source TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    snippet TEXT NOT NULL,
    kept BOOLEAN NOT NULL,
    severity INTEGER NOT NULL,
    category TEXT,
    published_at TIMESTAMPTZ NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  sql`CREATE INDEX IF NOT EXISTS classification_archive_kept_idx ON classification_archive (kept)`,
  sql`CREATE INDEX IF NOT EXISTS classification_archive_archived_at_idx ON classification_archive (archived_at)`,
  sql`CREATE TABLE IF NOT EXISTS pending_translation (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    handle TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    published_at TIMESTAMPTZ NOT NULL,
    discovered_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  sql`CREATE INDEX IF NOT EXISTS pending_translation_discovered_at_idx ON pending_translation (discovered_at)`,
  sql`CREATE TABLE IF NOT EXISTS feed_archive (
    id SERIAL PRIMARY KEY,
    source TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    category TEXT NOT NULL,
    country TEXT,
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    severity SMALLINT NOT NULL,
    published_at TIMESTAMPTZ NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  sql`CREATE INDEX IF NOT EXISTS feed_archive_country_idx ON feed_archive (country)`,
  sql`CREATE INDEX IF NOT EXISTS feed_archive_source_idx ON feed_archive (source)`,
  sql`CREATE INDEX IF NOT EXISTS feed_archive_published_at_idx ON feed_archive (published_at)`,
  sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS primary_event_id INTEGER REFERENCES events(id)`,
  sql`CREATE INDEX IF NOT EXISTS events_primary_event_id_idx ON events (primary_event_id)`,
  // Added nullable first (no default yet) so existing rows come in NULL,
  // not "pending" — a NOT NULL DEFAULT 'pending' in one step would have
  // retroactively hidden the entire existing live feed the moment this
  // column landed. The UPDATE is naturally idempotent (only ever touches
  // NULL rows — after the first run there are none, since the app always
  // sets this column explicitly on every insert going forward), so this
  // whole sequence is safe to leave in the repeatable migration list.
  sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS review_status TEXT`,
  sql`UPDATE events SET review_status = 'approved' WHERE review_status IS NULL`,
  sql`ALTER TABLE events ALTER COLUMN review_status SET NOT NULL`,
  sql`ALTER TABLE events ALTER COLUMN review_status SET DEFAULT 'pending'`,
  sql`CREATE INDEX IF NOT EXISTS events_review_status_idx ON events (review_status)`,
  sql`CREATE EXTENSION IF NOT EXISTS vector`,
  sql`ALTER TABLE feed_archive ADD COLUMN IF NOT EXISTS embedding vector(768)`,
  sql`CREATE INDEX IF NOT EXISTS feed_archive_embedding_idx ON feed_archive USING hnsw (embedding vector_cosine_ops)`,
  sql`CREATE TABLE IF NOT EXISTS ai_usage (
    id SERIAL PRIMARY KEY,
    date TEXT NOT NULL,
    kind TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT ai_usage_date_kind_unique UNIQUE (date, kind)
  )`,
  sql`CREATE TABLE IF NOT EXISTS country_briefs (
    id SERIAL PRIMARY KEY,
    country TEXT NOT NULL,
    brief_text TEXT NOT NULL,
    event_count INTEGER NOT NULL,
    model TEXT NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  sql`CREATE INDEX IF NOT EXISTS country_briefs_country_idx ON country_briefs (country)`,
  sql`CREATE INDEX IF NOT EXISTS country_briefs_generated_at_idx ON country_briefs (generated_at)`,
  sql`CREATE TABLE IF NOT EXISTS classifier_audit (
    id SERIAL PRIMARY KEY,
    archive_id INTEGER NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    snippet TEXT NOT NULL,
    severity INTEGER NOT NULL,
    reasoning TEXT NOT NULL,
    suggested_fix TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    review_note TEXT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  sql`CREATE INDEX IF NOT EXISTS classifier_audit_status_idx ON classifier_audit (status)`,
  sql`CREATE INDEX IF NOT EXISTS classifier_audit_created_at_idx ON classifier_audit (created_at)`,
  sql`ALTER TABLE classifier_audit ADD COLUMN IF NOT EXISTS url TEXT`,
  sql`ALTER TABLE classifier_audit ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`,
  sql`ALTER TABLE classifier_audit ADD COLUMN IF NOT EXISTS suggested_severity INTEGER`,
  sql`ALTER TABLE classifier_audit ADD COLUMN IF NOT EXISTS suggested_country TEXT`,
  // A single article can now carry more than one finding kind (e.g.
  // correctly included but with the wrong severity AND the wrong
  // country), so the old one-row-per-article UNIQUE(archive_id) has to
  // become UNIQUE(archive_id, kind) — drop the original column-level
  // constraint (Postgres's default auto-generated name for it) and
  // replace with a composite unique index, which Postgres's ON CONFLICT
  // matches against just as well as a named constraint.
  sql`ALTER TABLE classifier_audit DROP CONSTRAINT IF EXISTS classifier_audit_archive_id_key`,
  sql`CREATE UNIQUE INDEX IF NOT EXISTS classifier_audit_archive_kind_unique ON classifier_audit (archive_id, kind)`,
  sql`ALTER TABLE classification_archive ADD COLUMN IF NOT EXISTS audited_at TIMESTAMPTZ`,
  sql`CREATE INDEX IF NOT EXISTS classification_archive_audited_at_idx ON classification_archive (audited_at)`,
  // Project 3 (2026-09-09) — see classificationArchive.embedding's own doc
  // comment in schema.ts for why this needs its own backfill, separate
  // from feed_archive.embedding.
  sql`ALTER TABLE classification_archive ADD COLUMN IF NOT EXISTS embedding vector(768)`,
  sql`CREATE TABLE IF NOT EXISTS classifier_calibration (
    id SERIAL PRIMARY KEY,
    pattern TEXT NOT NULL UNIQUE,
    lesson TEXT NOT NULL,
    applies_to TEXT NOT NULL DEFAULT 'both',
    occurrences INTEGER NOT NULL DEFAULT 1,
    active BOOLEAN NOT NULL DEFAULT true,
    source_finding_id INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_reinforced_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  sql`CREATE INDEX IF NOT EXISTS classifier_calibration_active_idx ON classifier_calibration (active)`,
  sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS geocoded_at TIMESTAMPTZ`,
  sql`CREATE INDEX IF NOT EXISTS events_geocoded_at_idx ON events (geocoded_at)`,
  sql`CREATE INDEX IF NOT EXISTS events_published_at_idx ON events (published_at)`,
  sql`ALTER TABLE aircraft_count_history ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'military'`,
  sql`CREATE INDEX IF NOT EXISTS aircraft_count_history_kind_idx ON aircraft_count_history (kind)`,
  sql`CREATE TABLE IF NOT EXISTS gps_jamming_history (
    id SERIAL PRIMARY KEY,
    country TEXT NOT NULL,
    snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    bad_cell_count INTEGER NOT NULL,
    bad_aircraft_count INTEGER NOT NULL
  )`,
  sql`CREATE INDEX IF NOT EXISTS gps_jamming_history_country_idx ON gps_jamming_history (country)`,
  sql`CREATE INDEX IF NOT EXISTS gps_jamming_history_snapshot_at_idx ON gps_jamming_history (snapshot_at)`,
  sql`CREATE TABLE IF NOT EXISTS anomaly_findings (
    id SERIAL PRIMARY KEY,
    detected_at TIMESTAMPTZ NOT NULL,
    signal_type TEXT NOT NULL,
    country TEXT NOT NULL,
    category TEXT,
    observed_value DOUBLE PRECISION,
    baseline_mean DOUBLE PRECISION,
    baseline_std_dev DOUBLE PRECISION,
    sample_size INTEGER NOT NULL,
    jump DOUBLE PRECISION,
    z_score DOUBLE PRECISION NOT NULL,
    details TEXT
  )`,
  sql`CREATE INDEX IF NOT EXISTS anomaly_findings_detected_at_idx ON anomaly_findings (detected_at)`,
  sql`CREATE INDEX IF NOT EXISTS anomaly_findings_country_idx ON anomaly_findings (country)`,
  sql`CREATE INDEX IF NOT EXISTS anomaly_findings_signal_type_idx ON anomaly_findings (signal_type)`,
  // 2026-09-09, Project 2 (multivariate anomaly detection — see
  // src/db/schema.ts's own comment on anomalyFindings for why these three
  // become nullable and `details` is added): safe against the existing
  // production table since every prior row (all 5 original signals)
  // already has real values in observed_value/baseline_mean/baseline_std_
  // dev/jump — DROP NOT NULL doesn't touch existing data, it only stops
  // requiring a value going forward.
  sql`ALTER TABLE anomaly_findings ALTER COLUMN observed_value DROP NOT NULL`,
  sql`ALTER TABLE anomaly_findings ALTER COLUMN baseline_mean DROP NOT NULL`,
  sql`ALTER TABLE anomaly_findings ALTER COLUMN baseline_std_dev DROP NOT NULL`,
  sql`ALTER TABLE anomaly_findings ALTER COLUMN jump DROP NOT NULL`,
  sql`ALTER TABLE anomaly_findings ADD COLUMN IF NOT EXISTS details TEXT`,
  // Redesigned 2026-09-09 (same day as first shipped): the shadow model
  // now predicts a country's actual future score over several horizons
  // (linear regression) instead of a binary escalation flag (logistic
  // regression) — see riskModelRuns/riskPredictions's doc comments in
  // schema.ts. The old shape's tables were dropped and recreated by hand
  // in production once (2 test rows, no real data) rather than migrated
  // column-by-column here — a DROP has no business living in this file's
  // permanent, repeatedly-run statement list, so these CREATE statements
  // below reflect the new shape directly, safe for a genuinely fresh
  // install; they no-op (IF NOT EXISTS) against the production table this
  // file's own history already established by hand.
  sql`CREATE TABLE IF NOT EXISTS risk_model_runs (
    id SERIAL PRIMARY KEY,
    trained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    model_type TEXT NOT NULL DEFAULT 'linear-regression',
    horizon_days INTEGER NOT NULL,
    sample_size INTEGER NOT NULL,
    features TEXT,
    model_params TEXT,
    selected_l2 DOUBLE PRECISION,
    backtest_sample_size INTEGER NOT NULL,
    backtest_mae DOUBLE PRECISION,
    backtest_rmse DOUBLE PRECISION,
    backtest_naive_mae DOUBLE PRECISION,
    promoted BOOLEAN NOT NULL DEFAULT false,
    notes TEXT
  )`,
  sql`CREATE TABLE IF NOT EXISTS risk_predictions (
    id SERIAL PRIMARY KEY,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    model_run_id INTEGER NOT NULL,
    country TEXT NOT NULL,
    predicted_score DOUBLE PRECISION NOT NULL,
    predicted_threat_level SMALLINT NOT NULL,
    input_features TEXT NOT NULL,
    resolves_at TIMESTAMPTZ NOT NULL,
    actual_score DOUBLE PRECISION,
    actual_threat_level SMALLINT,
    absolute_error DOUBLE PRECISION,
    graded_at TIMESTAMPTZ
  )`,
  sql`CREATE INDEX IF NOT EXISTS risk_predictions_resolves_at_idx ON risk_predictions (resolves_at)`,
  sql`CREATE INDEX IF NOT EXISTS risk_predictions_country_idx ON risk_predictions (country)`,
  sql`CREATE INDEX IF NOT EXISTS risk_predictions_model_run_id_idx ON risk_predictions (model_run_id)`,
  // Real FK, added via raw SQL rather than Drizzle's .references() (this
  // schema has no .references() usage anywhere else to match, and
  // primary_event_id's own doc comment in schema.ts describes the same
  // raw-SQL-in-migrate approach). Postgres has no `ADD CONSTRAINT IF NOT
  // EXISTS` (unlike `ADD COLUMN IF NOT EXISTS`, which is supported) — the
  // DO-block/exception idiom below is the standard idempotent equivalent,
  // safe to run on every /api/admin/migrate call the same as every other
  // statement in this file.
  sql`DO $$ BEGIN
    ALTER TABLE risk_predictions ADD CONSTRAINT risk_predictions_model_run_id_fkey
      FOREIGN KEY (model_run_id) REFERENCES risk_model_runs(id);
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`,
  // Project 1 (2026-09-09) — narrative clustering over feed_archive's
  // existing embeddings. See narrativeClusters/narrativeNoveltyFindings's
  // own doc comments in schema.ts for the full design.
  sql`CREATE TABLE IF NOT EXISTS narrative_clusters (
    id SERIAL PRIMARY KEY,
    trained_at TIMESTAMPTZ NOT NULL,
    centroid vector(768) NOT NULL,
    member_count INTEGER NOT NULL,
    novelty_threshold DOUBLE PRECISION NOT NULL
  )`,
  sql`CREATE INDEX IF NOT EXISTS narrative_clusters_trained_at_idx ON narrative_clusters (trained_at)`,
  sql`CREATE TABLE IF NOT EXISTS narrative_novelty_findings (
    id SERIAL PRIMARY KEY,
    feed_archive_id INTEGER NOT NULL,
    detected_at TIMESTAMPTZ NOT NULL,
    outcome TEXT NOT NULL,
    nearest_cluster_id INTEGER,
    distance DOUBLE PRECISION
  )`,
  sql`CREATE INDEX IF NOT EXISTS narrative_novelty_findings_detected_at_idx ON narrative_novelty_findings (detected_at)`,
  // UNIQUE (not just FK/CHECK) constraints hit a real Postgres quirk the
  // other DO-blocks in this file don't: ADD CONSTRAINT ... UNIQUE creates
  // a backing index with the same name, and re-running after that index
  // already exists raises 42P07 "relation already exists" (duplicate_
  // table), not 42710 (duplicate_object) — confirmed live 2026-09-10, this
  // exact statement 500ing on every migrate call after its first success
  // is what caught it. Both must be caught for this to actually be
  // idempotent.
  sql`DO $$ BEGIN
    ALTER TABLE narrative_novelty_findings ADD CONSTRAINT narrative_novelty_findings_feed_archive_id_key
      UNIQUE (feed_archive_id);
  EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
  END $$`,
  sql`DO $$ BEGIN
    ALTER TABLE narrative_novelty_findings ADD CONSTRAINT narrative_novelty_findings_feed_archive_id_fkey
      FOREIGN KEY (feed_archive_id) REFERENCES feed_archive(id);
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`,
  sql`DO $$ BEGIN
    ALTER TABLE narrative_novelty_findings ADD CONSTRAINT narrative_novelty_findings_nearest_cluster_id_fkey
      FOREIGN KEY (nearest_cluster_id) REFERENCES narrative_clusters(id);
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`,
  // Project 3 (2026-09-09) — k-NN text classifier training/backtest runs.
  // See textClassifierRuns's own doc comment in schema.ts.
  // Project 4 (2026-09-09) — see riskModelRuns.modelType's own doc comment
  // in schema.ts. Existing rows (all pre-Project-4, all trained as linear
  // regression) get the correct default automatically.
  sql`ALTER TABLE risk_model_runs ADD COLUMN IF NOT EXISTS model_type TEXT NOT NULL DEFAULT 'linear-regression'`,
  sql`CREATE TABLE IF NOT EXISTS text_classifier_runs (
    id SERIAL PRIMARY KEY,
    trained_at TIMESTAMPTZ NOT NULL,
    k INTEGER NOT NULL,
    sample_size INTEGER NOT NULL,
    cv_accuracy DOUBLE PRECISION NOT NULL,
    backtest_sample_size INTEGER NOT NULL,
    backtest_agreement_rate DOUBLE PRECISION NOT NULL,
    promoted BOOLEAN NOT NULL DEFAULT false,
    notes TEXT
  )`,
  // Autonomous calibration corroboration staging (2026-09-10) — see
  // classifierCalibrationEvidence's own doc comment in schema.ts.
  sql`CREATE TABLE IF NOT EXISTS classifier_calibration_evidence (
    id SERIAL PRIMARY KEY,
    pattern TEXT NOT NULL,
    lesson TEXT NOT NULL,
    applies_to TEXT NOT NULL,
    archive_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    finding_id INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // See the narrative_novelty_findings DO-block above for why UNIQUE
  // constraints need OR duplicate_table here, unlike the plain FK/CHECK
  // ones elsewhere in this file.
  sql`DO $$ BEGIN
    ALTER TABLE classifier_calibration_evidence ADD CONSTRAINT classifier_calibration_evidence_pattern_archive_unique
      UNIQUE (pattern, archive_id);
  EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
  END $$`,
  sql`CREATE INDEX IF NOT EXISTS classifier_calibration_evidence_pattern_idx ON classifier_calibration_evidence (pattern)`,
  // Real-title backfill queue for GDELT bulk items (2026-09-10) — see
  // pendingGdeltTitle's own doc comment in schema.ts.
  sql`CREATE TABLE IF NOT EXISTS pending_gdelt_title (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    resolved_country TEXT NOT NULL,
    published_at TIMESTAMPTZ NOT NULL,
    discovered_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  sql`CREATE INDEX IF NOT EXISTS pending_gdelt_title_discovered_at_idx ON pending_gdelt_title (discovered_at)`,
  // Shadow-mode native-language classifier (2026-09-10) — built, shipped,
  // then reverted the same day (see git history) before it accumulated any
  // real comparison data. Dropping the two columns it added rather than
  // leaving them orphaned.
  sql`ALTER TABLE classification_archive DROP COLUMN IF EXISTS native_kept`,
  sql`ALTER TABLE classification_archive DROP COLUMN IF EXISTS native_severity`,
  // MBFC source-credibility cache (2026-09-11) — see sourceCredibility's
  // own doc comment in schema.ts.
  sql`CREATE TABLE IF NOT EXISTS source_credibility (
    id SERIAL PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    name TEXT,
    factual_rating TEXT,
    credibility TEXT,
    country TEXT,
    media_type TEXT,
    raw TEXT,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  sql`CREATE INDEX IF NOT EXISTS source_credibility_domain_idx ON source_credibility (domain)`,
  // bias_rating -> bias + political_bias (2026-09-11, same day, first
  // live sync) — MBFC's real schema turned out to carry two distinct
  // fields (see schema.ts's own doc comment on `bias`), confirmed only
  // after the actual call. Table was empty at this point (the first
  // insert attempt used the wrong key name and matched zero domains),
  // so this is a rename/add, not a real migration of live data.
  sql`ALTER TABLE source_credibility DROP COLUMN IF EXISTS bias_rating`,
  sql`ALTER TABLE source_credibility ADD COLUMN IF NOT EXISTS bias TEXT`,
  sql`ALTER TABLE source_credibility ADD COLUMN IF NOT EXISTS political_bias TEXT`,
];

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = getDb();
  for (const stmt of STATEMENTS) {
    await db.execute(stmt);
  }
  return NextResponse.json({ ok: true, statementsApplied: STATEMENTS.length });
}
