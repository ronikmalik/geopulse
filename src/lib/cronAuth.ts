import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

// Shared by every /api/ingest and /api/admin/* route. Accepts the secret
// two ways: an Authorization: Bearer header (what GitHub Actions and the
// admin kill-switch page send) or a ?secret= query param (for schedulers
// like cron-job.org whose custom-header UI isn't always easy to find — a
// URL param is one field every such tool exposes up front). Query-param
// auth means the secret can end up in access logs/referrers, so routes
// that MUTATE or DELETE data pass { headerOnly: true } and refuse the
// query-param form entirely — a leaked log line must never be enough to
// purge a source or run a migration.
//
// Comparison is constant-time (timingSafeEqual over equal-length buffers)
// so an attacker can't recover the secret byte-by-byte from response
// timing. Length mismatch short-circuits to false — that leaks only the
// secret's LENGTH, which is not useful on its own for a random secret.
//
// No secret configured: allowed only under `next dev` (NODE_ENV ===
// "development"). A production deploy that forgot to set CRON_SECRET fails
// CLOSED — every admin route 401s — rather than silently exposing purge/
// migrate/kill-switch to the internet (Codex hardening, 2026-09-19).
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isCronAuthorized(req: NextRequest, options?: { headerOnly?: boolean }): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV === "development";
  const auth = req.headers.get("authorization");
  if (auth && auth.startsWith("Bearer ") && secretMatches(auth.slice("Bearer ".length), secret)) {
    return true;
  }
  if (options?.headerOnly) return false;
  return secretMatches(req.nextUrl.searchParams.get("secret"), secret);
}
