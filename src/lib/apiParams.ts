import { NextResponse } from "next/server";
import { CATEGORIES, type Category } from "./categories";

// Shared input validation + response helpers for the PUBLIC, unauthenticated
// read routes (2026-09-19 security pass). Every query parameter these routes
// accept used to flow straight into a Drizzle query (parameterized, so never
// an injection risk) — but an unbounded string still meant unbounded work:
// a 10KB `?country=` still ran a full query, a made-up category still hit
// the DB, and every response was `Cache-Control: private` by default so
// the CDN never absorbed a single repeat request. These helpers make the
// contract explicit: reject junk with a 400 before any I/O, and let
// Vercel's CDN serve repeats of the same cheap read without waking a
// function at all.

const ISO2 = /^[A-Z]{2}$/;
const CATEGORY_SET = new Set<string>(CATEGORIES);

// Uppercased ISO 3166-1 alpha-2, or null if the param is missing/malformed.
// Deliberately format-only (not checked against COUNTRY_CENTROIDS): a code
// this app doesn't model just returns an empty result set, which is the
// correct answer, not an error.
export function parseCountryParam(raw: string | null): string | null {
  if (!raw) return null;
  const iso2 = raw.trim().toUpperCase();
  return ISO2.test(iso2) ? iso2 : null;
}

// A positive safe integer id, or null.
export function parseIdParam(raw: string | null): number | null {
  if (!raw) return null;
  if (!/^\d{1,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Comma-separated category slugs, validated against the CATEGORIES list
// and de-duplicated. Returns null if ANY entry is unknown — a client that
// sends a category this app doesn't have is malformed, not partially
// right.
export function parseCategoriesParam(raw: string | null): Category[] | null {
  if (!raw) return null;
  const parts = raw
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.length > CATEGORIES.length) return null;
  const unique = [...new Set(parts)];
  if (!unique.every((c) => CATEGORY_SET.has(c))) return null;
  return unique as Category[];
}

// Bounded integer with a default — `?days=` style params.
export function parseBoundedInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (!raw || !/^\d{1,9}$/.test(raw)) return fallback;
  return Math.min(max, Math.max(min, Number(raw)));
}

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

// JSON response the Vercel CDN is allowed to cache and share across every
// viewer for `sMaxAgeSeconds`, then serve stale for `swrSeconds` more while
// one background revalidation refreshes it. `max-age=0` keeps the BROWSER
// from caching it at all — the freshness contract lives at the edge, where
// one function invocation can serve everyone, not in each client's cache
// where it would just delay what that one client sees. This is the single
// biggest lever on Vercel Hobby's Active-CPU budget for the read side of
// this app: a layer that 30 open tabs each poll every minute becomes ~1
// invocation/minute instead of 30.
export function cachedJson<T>(data: T, sMaxAgeSeconds: number, swrSeconds = sMaxAgeSeconds): NextResponse {
  const res = NextResponse.json(data);
  res.headers.set(
    "Cache-Control",
    `public, max-age=0, s-maxage=${Math.max(1, Math.floor(sMaxAgeSeconds))}, stale-while-revalidate=${Math.max(0, Math.floor(swrSeconds))}`,
  );
  return res;
}
