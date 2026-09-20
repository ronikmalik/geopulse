import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cronAuth";
import { applyMigrations } from "@/lib/migrations";

// There's no migration framework in this project (no local Node install to
// run drizzle-kit, and the Neon connection string isn't retrievable via
// the Vercel API even with decrypt=true — likely wrapped by the Vercel/Neon
// marketplace integration). This is the pragmatic substitute: a protected
// endpoint that applies the current desired schema via idempotent
// CREATE/ALTER ... IF NOT EXISTS statements (src/lib/migrations.ts), run
// once by hand after a schema change ships — or from the Actions runner via
// `scripts/run-job.ts migrate`. Safe to hit repeatedly — every statement no-ops if
// already applied.
export const maxDuration = 55;

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req, { headerOnly: true })) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await applyMigrations();
  return NextResponse.json({ ok: true, ...result });
}
