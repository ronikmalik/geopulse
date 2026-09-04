import type { NextRequest } from "next/server";

// Shared by every /api/ingest and /api/admin/* route. Accepts the secret
// two ways: an Authorization: Bearer header (what GitHub Actions sends) or
// a ?secret= query param (for schedulers like cron-job.org whose custom-
// header UI isn't always easy to find — a URL param is one field every
// such tool exposes up front). Query-param auth means the secret can end
// up in access logs/referrers; acceptable here since this only gates
// re-running ingest/backfill/snapshot, not anything with real stakes.
export function isCronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured yet (local dev) — allow
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true;
  return req.nextUrl.searchParams.get("secret") === secret;
}
