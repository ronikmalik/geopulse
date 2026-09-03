import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";

// There's no migration framework in this project (no local Node install to
// run drizzle-kit, and the Neon connection string isn't retrievable via
// the Vercel API even with decrypt=true — likely wrapped by the Vercel/Neon
// marketplace integration). This is the pragmatic substitute: a protected
// endpoint that applies the current desired schema via idempotent
// CREATE/ALTER ... IF NOT EXISTS statements, run once by hand after a
// schema change ships. Safe to hit repeatedly — every statement no-ops if
// already applied.
export const maxDuration = 55;

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured yet (local dev) — allow
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

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
];

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = getDb();
  for (const stmt of STATEMENTS) {
    await db.execute(stmt);
  }
  return NextResponse.json({ ok: true, statementsApplied: STATEMENTS.length });
}
