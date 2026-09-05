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
