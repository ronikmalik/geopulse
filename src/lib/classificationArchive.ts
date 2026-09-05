import { sql, and, eq, gt, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { classificationArchive } from "@/db/schema";
import { isKnownIncidentVocabulary } from "./classify";
import { COUNTRY_NAME_TO_ALPHA2 } from "./countryNames";

export interface ClassificationOutcome {
  source: string;
  url: string;
  title: string;
  snippet: string;
  kept: boolean;
  severity: number;
  category: string | null;
  publishedAt: Date;
}

// Best-effort, fire-and-forget from the caller's perspective — archiving
// must never be able to fail or slow down the actual live ingest path.
// Same onConflictDoNothing(url) dedup pattern as events/insertDirectItems:
// the same RSS item reappearing across ingest cycles (it's still in the
// feed's rolling window) shouldn't create duplicate archive rows.
export async function archiveClassifications(
  outcomes: ClassificationOutcome[],
): Promise<void> {
  if (outcomes.length === 0) return;
  try {
    const db = getDb();
    await db
      .insert(classificationArchive)
      .values(outcomes)
      .onConflictDoNothing({ target: classificationArchive.url });
  } catch (err) {
    console.error(`archiveClassifications failed: ${err}`);
  }
}

// Batch existence check against a set of URLs, run before spending any
// translation budget on them — a post already archived here (kept or
// dropped) was already fully scored in a prior cycle, so re-translating
// it a second time (e.g. because two independent schedulers both hit
// /api/ingest within the same 15-minute Telegram rotation window, see
// docs/ARCHITECTURE.md) would burn real quota for zero new signal. See
// src/lib/sources/telegram.ts.
export async function getArchivedUrls(urls: string[]): Promise<Set<string>> {
  if (urls.length === 0) return new Set();
  const db = getDb();
  const rows = await db
    .select({ url: classificationArchive.url })
    .from(classificationArchive)
    .where(inArray(classificationArchive.url, urls));
  return new Set(rows.map((r) => r.url));
}

// Common English stopwords plus wire-service/RSS boilerplate that would
// otherwise dominate any frequency count without telling us anything about
// incident vocabulary specifically.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "so",
  "in", "on", "of", "to", "for", "with", "from", "by", "at", "as",
  "is", "are", "was", "were", "be", "been", "being", "has", "have",
  "had", "will", "would", "could", "should", "can", "may", "might",
  "its", "it's", "his", "her", "their", "our", "your", "my",
  "this", "that", "these", "those", "who", "what", "when", "where",
  "why", "how", "which", "not", "no", "yes", "do", "does", "did",
  "says", "said", "say", "new", "over", "into", "amid", "after",
  "before", "up", "down", "out", "off", "about", "against", "between",
  "among", "during", "while", "still", "also", "just", "more", "most",
  "some", "all", "one", "two", "three", "first", "second", "third",
  "reuters", "ap", "afp", "report", "reports", "reported", "reporting",
  "week", "month", "year", "years", "day", "days", "time", "amp",
]);

// World leaders and political figures that show up constantly in
// geopolitical headlines regardless of whether the story is a fresh
// incident — evidence-based, not a preemptive guess: a real first
// production run of the vocabulary report (2026-09-04) came back
// dominated by "trump"/"trumps"/"donald"/"milei" as the top "candidates",
// none of them useful (COUNTRY_NAME_TO_ALPHA2, reused below, already
// covers the flashpoint-country leaders — Putin, Zelensky, Netanyahu,
// Khamenei, Xi — this list is deliberately just the gap that list didn't
// close). Expect to keep growing this the same way — a real report
// surfaces a dominant non-incident proper noun, add it here — rather than
// trying to enumerate every current world leader up front.
const PROPER_NOUN_NOISE = new Set(["trump", "donald", "milei", "farage", "starmer"]);

const COUNTRY_AND_DEMONYM_NOISE = new Set(Object.keys(COUNTRY_NAME_TO_ALPHA2));

// A possessive ("Israel's", "Russia's") survives tokenize()'s apostrophe
// stripping as a trailing "s" ("israels", "russias") — checking both the
// word and its de-possessivized form against the noise sets catches that
// without needing a separate possessive-aware tokenizer.
function isProperNounNoise(word: string): boolean {
  const bare = word.endsWith("s") ? word.slice(0, -1) : word;
  return (
    COUNTRY_AND_DEMONYM_NOISE.has(word) ||
    COUNTRY_AND_DEMONYM_NOISE.has(bare) ||
    PROPER_NOUN_NOISE.has(word) ||
    PROPER_NOUN_NOISE.has(bare)
  );
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !isProperNounNoise(w));
}

export interface VocabularyCandidate {
  phrase: string;
  count: number;
  examples: string[];
}

const MAX_EXAMPLES_PER_CANDIDATE = 3;
const MIN_OCCURRENCES = 3;

// Word- and bigram-frequency analysis over recently-dropped items only —
// kept items already pass, so the interesting signal for "what vocabulary
// are we missing" lives entirely in what got excluded. Candidates already
// covered by any existing severity/benign pattern are filtered out via
// isKnownIncidentVocabulary, so this only ever surfaces genuinely new
// words/phrases, not ones we already act on. This is a discovery tool,
// not a decision-maker: it surfaces candidates with real example
// headlines for a human to judge — see the "why not auto-apply this"
// reasoning in src/app/api/admin/vocabulary-report/route.ts. Bigrams are
// included alongside single words because several of the real incident
// terms added this session ("state of emergency", "death toll", "border
// incident") are two-word phrases, not single words.
export function findVocabularyCandidates(
  items: { title: string; snippet: string }[],
): VocabularyCandidate[] {
  const counts = new Map<string, { count: number; examples: Set<string> }>();

  for (const item of items) {
    const text = `${item.title} ${item.snippet}`;
    const words = tokenize(text);
    const phrases = new Set<string>();
    for (let i = 0; i < words.length; i++) {
      phrases.add(words[i]);
      if (i + 1 < words.length) phrases.add(`${words[i]} ${words[i + 1]}`);
    }
    for (const phrase of phrases) {
      if (isKnownIncidentVocabulary(phrase)) continue;
      const entry = counts.get(phrase) ?? { count: 0, examples: new Set<string>() };
      entry.count += 1;
      if (entry.examples.size < MAX_EXAMPLES_PER_CANDIDATE) entry.examples.add(item.title);
      counts.set(phrase, entry);
    }
  }

  return [...counts.entries()]
    .filter(([, v]) => v.count >= MIN_OCCURRENCES)
    .map(([phrase, v]) => ({ phrase, count: v.count, examples: [...v.examples] }))
    .sort((a, b) => b.count - a.count);
}

export interface ArchiveSummary {
  totalArchived: number;
  keptCount: number;
  droppedCount: number;
  windowDays: number;
}

export async function getArchiveSummary(windowDays: number): Promise<ArchiveSummary> {
  const db = getDb();
  const rows = await db
    .select({
      kept: classificationArchive.kept,
      count: sql<number>`count(*)`,
    })
    .from(classificationArchive)
    .where(gt(classificationArchive.archivedAt, sql`now() - interval '${sql.raw(String(windowDays))} days'`))
    .groupBy(classificationArchive.kept);

  const keptCount = Number(rows.find((r) => r.kept)?.count ?? 0);
  const droppedCount = Number(rows.find((r) => !r.kept)?.count ?? 0);
  return { totalArchived: keptCount + droppedCount, keptCount, droppedCount, windowDays };
}

// Dropped-only, most-recent-first, capped — this is meant to feed a
// vocabulary report on demand, not to be a general-purpose archive reader,
// so it doesn't need pagination.
const MAX_DROPPED_ITEMS_FOR_ANALYSIS = 3000;

export async function getRecentDroppedItems(
  windowDays: number,
): Promise<{ title: string; snippet: string }[]> {
  const db = getDb();
  return db
    .select({ title: classificationArchive.title, snippet: classificationArchive.snippet })
    .from(classificationArchive)
    .where(
      and(
        eq(classificationArchive.kept, false),
        gt(classificationArchive.archivedAt, sql`now() - interval '${sql.raw(String(windowDays))} days'`),
      ),
    )
    .orderBy(sql`${classificationArchive.archivedAt} desc`)
    .limit(MAX_DROPPED_ITEMS_FOR_ANALYSIS);
}
