import { sql, eq, and, isNull, gt } from "drizzle-orm";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { COUNTRY_NAME_TO_ALPHA2 } from "./countryNames";

// Cross-outlet duplicate detection: multiple RSS/GDELT sources often report
// the exact same real-world incident within the same news cycle. The
// existing correlationGroupId (src/lib/correlation.ts) is too coarse for
// this — "country:pillar:day" would merge every distinct story in a pillar
// on the same day, not just genuine duplicates. This does real content
// comparison instead: two items are the same story only if their
// (title+summary) text is actually similar, not just topically/temporally
// adjacent.
//
// No LLM/ML — Jaccard similarity over a filtered word set, the same
// keyword-heuristic spirit as classify.ts. Calibrated against 5 real
// headlines (BBC/Meduza/Moscow Times/CBC/ABC Australia all reporting the
// same Russian drone strike on Ukraine's SBU HQ, 2026-09-04) plus 6 real
// headlines about genuinely different Russia-Ukraine drone stories from
// the same day: bare word overlap put a genuinely-different pair (0.214)
// inside the same-event score range (0.000-0.500), meaning no threshold
// could separate them cleanly. Excluding generic conflict-topic vocabulary
// (country/demonym names, generic incident verbs) fixed this completely —
// zero cross-contamination in the calibration set at any threshold above
// ~0.1. Calibrated conservatively toward PRECISION, not recall: for this
// feature specifically, a false merge (hiding a real distinct story as a
// "duplicate," misattributing a source that never covered it) is worse
// than a false split (two duplicate articles both showing up separately —
// just today's status quo, not actively wrong). That's the opposite
// priority from the breaking-news inclusion bar in classify.ts, where the
// user explicitly asked to favor recall.

// idf/un/eu/nato added after a real false-merge caught in live testing
// (2026-09-04): two GENUINELY DIFFERENT Haaretz stories — a West Bank
// settler-raid killing and an unrelated Gaza Yellow-Line shooting —
// scored 0.182 similarity (above the 0.15 threshold) purely because both
// mentioned "IDF" and "two" killed. "IDF" is exactly as generic in
// Israel-Palestine coverage as "military"/"forces" already excluded above
// — it appears in nearly every security story regardless of which
// specific incident. Cardinal number words handled separately below
// (isNumberWord), not listed here — "two" people killed twice in one day,
// in unrelated incidents, is a real, easy coincidence.
const GENERIC_INCIDENT_NOISE = new Set([
  "attack", "attacks", "attacked", "attacking",
  "strike", "strikes", "struck",
  "hit", "hits",
  "drone", "drones", "missile", "missiles",
  "killed", "dead", "death", "deaths", "wounded", "injured", "casualties",
  "forces", "military", "troops", "security",
  "war", "conflict", "official", "officials", "government",
  "minister", "president", "says", "said", "say", "reports", "reported",
  "according", "news",
  "idf", "un", "eu", "nato",
]);

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "so",
  "in", "on", "of", "to", "for", "with", "from", "by", "at", "as",
  "is", "are", "was", "were", "be", "been", "being", "has", "have",
  "had", "will", "would", "could", "should", "its", "it's", "his",
  "her", "their", "our", "your", "this", "that", "these", "those",
  "after", "over", "against", "amid", "into", "about", "new",
]);

// Same false-merge case: both Haaretz stories described "two" people
// killed — a coincidence between unrelated incidents, not a shared-story
// signal. Written out rather than a numeric regex since headlines almost
// always spell small counts as words.
const NUMBER_WORDS = new Set([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "dozen", "dozens", "several", "many",
  "few", "multiple", "hundred", "hundreds", "thousand", "thousands",
]);

const COUNTRY_AND_DEMONYM_NOISE = new Set(Object.keys(COUNTRY_NAME_TO_ALPHA2));

function isNoiseWord(word: string): boolean {
  const bare = word.endsWith("s") ? word.slice(0, -1) : word;
  return (
    STOPWORDS.has(word) ||
    GENERIC_INCIDENT_NOISE.has(word) ||
    NUMBER_WORDS.has(word) ||
    COUNTRY_AND_DEMONYM_NOISE.has(word) ||
    COUNTRY_AND_DEMONYM_NOISE.has(bare)
  );
}

export function tokenizeForSimilarity(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/['’]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !isNoiseWord(w)),
  );
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Conservative on purpose — see the calibration note above. 0.15 sits just
// below the weakest genuine-duplicate score observed (0.167) while
// clearing every genuinely-different-story score observed (max 0.091) with
// real margin. Expect to revisit once the real archive/events data (not
// just this one calibration set) shows what the distribution actually
// looks like at scale.
export const SIMILARITY_THRESHOLD = 0.15;

// User feedback (2026-09-05): the original 48h window was catching more
// than the same-incident-different-outlets case it was built for — a
// genuine follow-up development ("Ukraine escalates" ... "Ukraine
// escalates further" a few hours later) could score above
// SIMILARITY_THRESHOLD against the earlier report (both largely stripped
// down to the same one or two substantive tokens once country names and
// generic incident vocabulary are excluded — see tokenizeForSimilarity),
// and 48h was easily wide enough to let that match, hiding a real distinct
// development as if it were a re-report of the same one. The dedup this
// exists for — multiple outlets picking up the exact same wire story —
// realistically clusters within roughly an hour on a real breaking story,
// not hours later; explicit user direction was "only reject if reported
// on just very very recently." 90 minutes is comfortably inside "same
// news cycle, multiple outlets" while comfortably outside "a few hours
// later" — a real escalation update now surfaces as its own item instead
// of being folded into the original as a hidden duplicate source.
const DEDUP_LOOKBACK_MINUTES = 90;

export interface PrimaryCandidate {
  id: number;
  title: string;
  summary: string;
}

// Existing, already-stored primary events (primaryEventId IS NULL) for one
// country+category within the lookback window — the pool a new item gets
// compared against. Separate from the matching logic itself so the pure
// comparison function (findDuplicateOf below) can be tested without a DB.
export async function fetchRecentPrimaries(
  country: string,
  category: string,
  beforeOrAt: Date,
): Promise<PrimaryCandidate[]> {
  const db = getDb();
  const since = new Date(beforeOrAt.getTime() - DEDUP_LOOKBACK_MINUTES * 60_000);
  const rows = await db
    .select({ id: events.id, title: events.title, summary: events.summary })
    .from(events)
    .where(
      and(
        eq(events.country, country),
        eq(events.category, category),
        isNull(events.primaryEventId),
        gt(events.publishedAt, since),
      ),
    );
  return rows;
}

// Pure — takes a pre-fetched candidate pool rather than querying itself, so
// it can be unit-tested and reused for same-ingest-cycle matching (where
// the "pool" is other items from the same batch, not yet in the DB) as
// well as against-the-DB matching.
export function findDuplicateOf(
  candidate: { title: string; summary: string },
  pool: PrimaryCandidate[],
): number | null {
  const candidateTokens = tokenizeForSimilarity(`${candidate.title} ${candidate.summary}`);
  if (candidateTokens.size === 0) return null;

  let best: { id: number; score: number } | null = null;
  for (const existing of pool) {
    const score = jaccardSimilarity(
      candidateTokens,
      tokenizeForSimilarity(`${existing.title} ${existing.summary}`),
    );
    if (score >= SIMILARITY_THRESHOLD && (!best || score > best.score)) {
      best = { id: existing.id, score };
    }
  }
  return best?.id ?? null;
}

export interface DuplicateSource {
  id: number;
  source: string;
  url: string;
  title: string;
  summary: string;
  publishedAt: string;
}

// The additional-source list for one primary event — what the feed shows
// when a clustered story is expanded. See GET /api/events/duplicates.
export async function getDuplicatesOf(primaryId: number): Promise<DuplicateSource[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: events.id,
      source: events.source,
      url: events.url,
      title: events.title,
      summary: events.summary,
      publishedAt: events.publishedAt,
    })
    .from(events)
    .where(eq(events.primaryEventId, primaryId))
    .orderBy(sql`${events.publishedAt} asc`);
  return rows.map((r) => ({ ...r, publishedAt: r.publishedAt.toISOString() }));
}
