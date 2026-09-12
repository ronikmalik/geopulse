import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { sourceCredibility } from "@/db/schema";

// MBFC (Media Bias/Fact Check) domain-level credibility database, synced
// in bulk and cached locally — see sourceCredibility's own doc comment in
// schema.ts for why this is a bulk-sync-then-cache design, not a live
// per-classification API call. The account backing MBFC_RAPIDAPI_KEY is
// HARD-CAPPED at 3 requests/month total (confirmed against the real
// subscribed plan, not a guess) — this file's syncSourceCredibility is
// meant to be invoked manually/rarely (a monthly cron at most), never
// from inside the ingest cycle.
const MBFC_HOST = "media-bias-fact-check-ratings-api2.p.rapidapi.com";
const MBFC_ENDPOINT = `https://${MBFC_HOST}/fetch-data`;
const REQUEST_TIMEOUT_MS = 60_000; // a ~9,000-row response is a real payload, not a quick call

function normalizeDomain(raw: string): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  // Accept either a bare domain or a full URL — MBFC's own schema isn't
  // confirmed yet (this is the first real sync), so tolerate both rather
  // than assume.
  if (s.includes("://")) {
    try {
      s = new URL(s).hostname;
    } catch {
      // fall through, try as a bare string below
    }
  }
  s = s.replace(/^www\./, "").replace(/\/$/, "");
  return s || null;
}

// Best-effort field extraction (2026-09-11, first real sync) — MBFC's
// exact JSON key names for this RapidAPI listing weren't confirmed ahead
// of time (their docs pages are client-rendered and didn't expose an
// example response before spending one of the 3 monthly calls to find
// out for real). Tries a handful of plausible key-name variants per
// field rather than assuming one; the full raw record is stored
// regardless (see `raw` column) so a wrong guess here is fixable later
// by re-reading the already-fetched data, not by spending another call.
function pick(record: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = record[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function extractDomainCandidate(record: Record<string, unknown>): string | null {
  const direct = pick(record, [
    "domain",
    "Domain",
    "url",
    "URL",
    "source_url",
    "website",
    "Website",
    "site",
  ]);
  return direct ? normalizeDomain(direct) : null;
}

export interface SyncResult {
  fetched: number;
  upserted: number;
  skippedNoDomain: number;
  sampleKeys: string[];
}

export async function syncSourceCredibility(): Promise<SyncResult> {
  const apiKey = process.env.MBFC_RAPIDAPI_KEY;
  if (!apiKey) throw new Error("MBFC_RAPIDAPI_KEY not set");

  const res = await fetch(MBFC_ENDPOINT, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "x-rapidapi-host": MBFC_HOST,
      "x-rapidapi-key": apiKey,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`MBFC fetch-data failed: ${res.status} ${body.slice(0, 500)}`);
  }

  const data = await res.json();

  // The top-level shape isn't confirmed either — could be a bare array,
  // or an object with the array under a wrapper key (data/results/sources
  // are the common conventions). Handle all three defensively.
  let records: unknown[];
  if (Array.isArray(data)) {
    records = data;
  } else if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const wrapped = obj.data ?? obj.results ?? obj.sources ?? obj.records;
    records = Array.isArray(wrapped) ? wrapped : [];
  } else {
    records = [];
  }

  const sampleKeys =
    records.length > 0 && records[0] && typeof records[0] === "object"
      ? Object.keys(records[0] as Record<string, unknown>)
      : [];

  const db = getDb();
  let upserted = 0;
  let skippedNoDomain = 0;

  for (const r of records) {
    if (!r || typeof r !== "object") {
      skippedNoDomain++;
      continue;
    }
    const record = r as Record<string, unknown>;
    const domain = extractDomainCandidate(record);
    if (!domain) {
      skippedNoDomain++;
      continue;
    }

    const name = pick(record, ["name", "Name", "source", "Source", "source_name"]);
    const biasRating = pick(record, ["bias", "Bias", "bias_rating", "biasRating", "political_bias"]);
    const factualRating = pick(record, [
      "factual_reporting",
      "factualReporting",
      "factual_rating",
      "factualRating",
      "factual",
      "Factual Reporting",
    ]);
    const credibility = pick(record, ["credibility", "Credibility", "credibility_rating"]);
    const country = pick(record, ["country", "Country"]);
    const mediaType = pick(record, ["media_type", "mediaType", "type", "Type"]);

    await db
      .insert(sourceCredibility)
      .values({
        domain,
        name,
        biasRating,
        factualRating,
        credibility,
        country,
        mediaType,
        raw: JSON.stringify(record),
      })
      .onConflictDoUpdate({
        target: sourceCredibility.domain,
        set: {
          name,
          biasRating,
          factualRating,
          credibility,
          country,
          mediaType,
          raw: JSON.stringify(record),
          fetchedAt: new Date(),
        },
      });
    upserted++;
  }

  return { fetched: records.length, upserted, skippedNoDomain, sampleKeys };
}

export interface CredibilityLookup {
  domain: string;
  biasRating: string | null;
  factualRating: string | null;
  credibility: string | null;
}

// One SELECT for the whole (small, local) table — loaded once per ingest
// cycle by the caller and passed through as a plain Map, not re-queried
// per candidate. See classify.ts's own use of this.
export async function loadCredibilityMap(): Promise<Map<string, CredibilityLookup>> {
  const db = getDb();
  const rows = await db
    .select({
      domain: sourceCredibility.domain,
      biasRating: sourceCredibility.biasRating,
      factualRating: sourceCredibility.factualRating,
      credibility: sourceCredibility.credibility,
    })
    .from(sourceCredibility);
  const map = new Map<string, CredibilityLookup>();
  for (const r of rows) map.set(r.domain, r);
  return map;
}

export async function getCredibilityCount(): Promise<number> {
  const db = getDb();
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(sourceCredibility);
  return Number(row?.count ?? 0);
}
