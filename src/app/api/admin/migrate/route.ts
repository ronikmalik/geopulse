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
