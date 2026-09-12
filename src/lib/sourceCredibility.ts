import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { sourceCredibility } from "@/db/schema";

// MBFC (Media Bias/Fact Check) domain-level credibility database, synced
// in bulk and cached locally — see sourceCredibility's own doc comment in
// schema.ts for why this is a bulk-sync-then-cache design, not a live
// per-classification API call. The account backing MBFC_RAPIDAPI_KEY is
// HARD-CAPPED at 3 requests/month total (confirmed against the real
// subscribed plan, not a guess) — this file's syncSourceCredibility is
// meant to be invoked manually/rarely, never from inside the ingest cycle.
const MBFC_HOST = "media-bias-fact-check-ratings-api2.p.rapidapi.com";
const MBFC_ENDPOINT = `https://${MBFC_HOST}/fetch-data`;
const REQUEST_TIMEOUT_MS = 60_000; // an ~11,000-row response is a real payload, not a quick call

// Real field names confirmed via the first live sync (2026-09-11): a flat
// array of objects, keys "Source", "Source URL", "Bias", "Political
// Bias", "Factual Reporting", "Credibility", "Country", "Media Type",
// "MBFC URL", "Source ID#", "Factual Score", plus a trailing empty-string
// key (a CSV-export artifact upstream, ignored). No pagination, no
// filtering — this is the entire database in one response.
interface MbfcRecord {
  Source?: string;
  "Source URL"?: string;
  Bias?: string;
  "Political Bias"?: string;
  "Factual Reporting"?: string;
  Credibility?: string;
  Country?: string;
  "Media Type"?: string;
}

// ~936 of 11,009 real records carry a path after the domain (e.g.
// "metapedia.org/wiki/Main_Page") rather than a bare hostname — this
// strips everything after the first "/" rather than relying on the URL
// parser (most values here have no scheme, so `new URL()` would throw on
// the majority of rows).
export function normalizeDomain(raw: string): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (s.includes("://")) {
    try {
      s = new URL(s).hostname;
    } catch {
      // fall through, treat as a bare string below
    }
  }
  s = s.split("/")[0].replace(/^www\./, "");
  return s || null;
}

export interface SyncResult {
  fetched: number;
  upserted: number;
  skippedNoDomain: number;
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

  const records = (await res.json()) as MbfcRecord[];
  if (!Array.isArray(records)) {
    throw new Error(`MBFC fetch-data returned unexpected shape: ${typeof records}`);
  }

  const db = getDb();
  let upserted = 0;
  let skippedNoDomain = 0;

  for (const record of records) {
    const domain = normalizeDomain(record["Source URL"] ?? "");
    if (!domain) {
      skippedNoDomain++;
      continue;
    }

    const values = {
      domain,
      name: record.Source ?? null,
      bias: record.Bias ?? null,
      politicalBias: record["Political Bias"] ?? null,
      factualRating: record["Factual Reporting"] ?? null,
      credibility: record.Credibility ?? null,
      country: record.Country ?? null,
      mediaType: record["Media Type"] ?? null,
      raw: JSON.stringify(record),
    };

    await db
      .insert(sourceCredibility)
      .values(values)
      .onConflictDoUpdate({
        target: sourceCredibility.domain,
        set: { ...values, fetchedAt: new Date() },
      });
    upserted++;
  }

  return { fetched: records.length, upserted, skippedNoDomain };
}

export interface CredibilityLookup {
  domain: string;
  bias: string | null;
  factualRating: string | null;
  credibility: string | null;
}

// MBFC's own explicit disqualifying categories — distinct from ordinary
// political-lean labels (Left/Left-Center/Least Biased/Right-Center/
// Right/Pro-Science), which stay in scope regardless of which side they
// lean. See schema.ts's own doc comment for the real confirmed examples
// (Xinhua/Sputnik/Press TV/Breitbart all carry one of these, Daily Caller
// does not despite also being politically right-leaning).
const DISQUALIFYING_BIAS_CATEGORIES = new Set(["Questionable", "Conspiracy-Pseudoscience", "Satire"]);
// "Mixed" sits below "Mostly Factual" on MBFC's own factual-reporting scale
// but ABOVE Low/Very Low — deliberately NOT disqualifying here (tried
// 2026-09-11, reverted same day) since it excludes real, commonly-cited
// outlets like Al Jazeera (Mixed factual / High credibility) alongside the
// low-effort local-news-mill sites it was meant to catch; Credibility and
// Bias alone already catch the genuinely unreliable end of "Mixed".
const DISQUALIFYING_FACTUAL_RATINGS = new Set(["Low", "Very Low"]);
const DISQUALIFYING_CREDIBILITY = new Set(["Low"]);

// The single gating decision classify.ts actually needs — kept here
// (not duplicated in classify.ts) so the definition of "low credibility"
// per this data source has exactly one place to change. Returns false
// (don't reject) for a domain with no MBFC entry at all — no data is not
// evidence of anything, the same "don't flag on mere unfamiliarity"
// principle already applied to Gemini's own credibility judgment.
export function isLowCredibility(lookup: CredibilityLookup | undefined): boolean {
  if (!lookup) return false;
  if (lookup.bias && DISQUALIFYING_BIAS_CATEGORIES.has(lookup.bias)) return true;
  if (lookup.factualRating && DISQUALIFYING_FACTUAL_RATINGS.has(lookup.factualRating)) return true;
  if (lookup.credibility && DISQUALIFYING_CREDIBILITY.has(lookup.credibility)) return true;
  return false;
}

// A live coverage check (2026-09-11) found real state-media evasion: MBFC
// rates the bare domain "news.cn" as Questionable/Low, but Xinhua's English
// arm publishes from "english.news.cn" — an exact-match lookup on the full
// hostname never finds it. Same for "news.antiwar.com" against a listed
// "antiwar.com". This tries the full hostname first, then progressively
// strips the leftmost label, stopping once only 2 labels remain (never
// tries a bare "cn"/"com" — collapsing to a real public-suffix-style TLD
// would risk matching a coincidental short MBFC row against unrelated
// sites). Safe by construction: MBFC's ~9k rows are real curated outlet
// domains, not generic strings, so a false hit on a stripped 2-label
// candidate (e.g. "co.uk" itself being a listed row) isn't a realistic risk.
export function lookupCredibility(
  domain: string,
  map: Map<string, CredibilityLookup>,
): CredibilityLookup | undefined {
  const labels = domain.split(".");
  for (let i = 0; i <= labels.length - 2; i++) {
    const hit = map.get(labels.slice(i).join("."));
    if (hit) return hit;
  }
  return undefined;
}

// One SELECT for the whole (small, local) table — loaded once per ingest
// cycle by the caller and passed through as a plain Map, not re-queried
// per candidate. See classify.ts's own use of this.
export async function loadCredibilityMap(): Promise<Map<string, CredibilityLookup>> {
  const db = getDb();
  const rows = await db
    .select({
      domain: sourceCredibility.domain,
      bias: sourceCredibility.bias,
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
