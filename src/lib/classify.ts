import { generateObject } from "ai";
import { z } from "zod";
import { NEWS_CATEGORIES, type NewsCategory } from "./categories";
import type { RawItem } from "./sources/gdelt";
import { resolveCountryFromText } from "./countryNames";
import { COUNTRY_CENTROIDS } from "./countryCentroids";

// LLM classification only ever assigns news-query-driven categories (plus
// "other") — the feed-driven categories (earthquake, natural-disaster) are
// pre-classified by their own source modules and never routed through here.
const CLASSIFIABLE_CATEGORIES = [...NEWS_CATEGORIES, "other"] as const;

// Deliberately broad — this is just the topical net (does the article touch
// international security/politics/instability at all?), not a judgment
// about whether it describes an actual notable development. That judgment
// happens in classifyByKeywords below, via NON_EVENT_PATTERNS and
// BENIGN_PATTERNS, so widening this list to cover more of "all relevant
// live news" (not just the five original flashpoints) doesn't by itself
// let routine/non-threat items through as risk signals.
const KEYWORDS =
  /iran|israel|gaza|palestin|hamas|hezbollah|lebanon|russia|ukraine|kremlin|putin|zelensk|taiwan|beijing|china.*military|north korea|kim jong|pyongyang|missile|airstrike|nuclear|sanctions|troops|invasion|ceasefire|drone strike|coup|martial law|insurgency|rebel|militia|terroris|extremis|uprising|unrest|crackdown|junta|regime|embargo|blockade|airspace violation|border clash|skirmish|mobiliz|annex|separatist|secession|genocide|war crime|refugee crisis|mass displacement|cyberattack|state-sponsored hacking/i;

export function isLikelyGeopolitical(item: RawItem): boolean {
  return KEYWORDS.test(item.title) || KEYWORDS.test(item.snippet);
}

const classifiedItemSchema = z.object({
  id: z.number(),
  relevant: z
    .boolean()
    .describe(
      "true only if this is a real, specific geopolitical/military/conflict event or development (not opinion, sports, culture, or unrelated news)",
    ),
  summary: z
    .string()
    .describe("One tight sentence, under 200 characters, plain factual tone"),
  category: z.enum(CLASSIFIABLE_CATEGORIES),
  location: z
    .string()
    .describe("Primary place name the event is centered on, e.g. 'Tehran, Iran'"),
  country: z
    .string()
    .length(2)
    .describe(
      "ISO 3166-1 alpha-2 code of the country the event is centered in, e.g. 'IR' for Iran, uppercase",
    ),
  lat: z.number(),
  lon: z.number(),
  severity: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe(
      "1=minor/diplomatic statement, 3=notable escalation, 5=major military action or strike with casualties",
    ),
});

export type ClassifiedItem = z.infer<typeof classifiedItemSchema>;

const batchSchema = z.object({
  items: z.array(classifiedItemSchema),
});

export async function classifyBatch(
  items: RawItem[],
): Promise<Map<number, ClassifiedItem>> {
  if (items.length === 0) return new Map();

  const prompt = items
    .map(
      (item, i) =>
        `[${i}] TITLE: ${item.title}\nCONTEXT: ${item.snippet}\nSOURCE: ${item.source}`,
    )
    .join("\n\n");

  const { object } = await generateObject({
    model: "openai/gpt-4o-mini",
    schema: batchSchema,
    system:
      "You are a geopolitical intelligence analyst triaging a live news feed for a situation-awareness map. " +
      "For each numbered item, decide if it is a genuine, specific geopolitical/conflict event, then extract a factual one-line summary, " +
      "the category, the primary location and its ISO 3166-1 alpha-2 country code, approximate real-world latitude/longitude, and a 1-5 severity score. " +
      "Reject opinion pieces, retrospectives, sports, and anything not tied to a concrete event.",
    prompt,
  });

  const map = new Map<number, ClassifiedItem>();
  for (const item of object.items) {
    map.set(item.id, item);
  }
  return map;
}

// Free, no-API-key fallback classifier. classifyBatch (above) needs a
// Vercel AI Gateway account with a payment method on file even to use free
// credits — not something to assume the deployer wants — so this is the
// default path: no LLM, no summary generation, but it doesn't depend on
// anything beyond the category keyword patterns already used to build the
// GDELT queries in categories.ts. Trade-off: the "summary" is just the raw
// title, and location resolution is best-effort text matching rather than
// an LLM's judgment, but it costs nothing and has no external dependency
// beyond the news source itself.
const CATEGORY_MATCHERS: [NewsCategory, RegExp][] = [
  ["us-iran", /\biran\b/i],
  ["russia-ukraine", /\brussia\b|\bkremlin\b|\bputin\b/i],
  ["israel-palestine", /\bisrael\b|\bgaza\b|\bpalestin|\bhamas\b|\bhezbollah\b/i],
  ["china-taiwan", /\btaiwan\b/i],
  ["north-korea", /north korea|pyongyang|kim jong/i],
  [
    "political-instability",
    /\bcoup\b|martial law|state of emergency|election fraud|government collapse|ousted|overthrown/i,
  ],
  [
    "humanitarian",
    /famine|food insecurity|malnutrition|refugee|displaced|displacement|humanitarian crisis|humanitarian emergency|disease outbreak|epidemic/i,
  ],
];

// A flashpoint category is thematically tied to a specific country even
// when the article text doesn't happen to name it in a form
// resolveCountryFromText recognizes (e.g. "Tehran" without "Iran").
const CATEGORY_FALLBACK_COUNTRY: Partial<Record<NewsCategory, string>> = {
  "us-iran": "IR",
  "russia-ukraine": "UA",
  "israel-palestine": "IL",
  "china-taiwan": "TW",
  "north-korea": "KP",
};

// Explainers, retrospectives, and analysis pieces routinely reuse the same
// vocabulary as breaking news (they're often ABOUT a real conflict) without
// describing a new development themselves — "Who are the 'Hilltop Girls'
// behind Israel's settlement strategy?" is not a risk event just because it
// mentions Israel. Matched against the title only: these phrasings are a
// headline convention, not something that shows up mid-article.
const NON_EVENT_TITLE_PATTERNS =
  /^(what to know|explainer|analysis|opinion|q&a|in pictures|in photos|photos:|the backstory|timeline:|explained:)\b|explainer$|^(who is|who are|why is|why did|why does|how is|how did|how does|what happened)\b|:\s*(what to know|what happened|explained|explainer|analysis|q&a)\b/i;

// Coverage of an ongoing/pre-existing situation rather than a fresh
// development — "years after the invasion, X still..." reads as current
// (mentions the invasion) but isn't reporting anything new today.
const ONGOING_COVERAGE_PATTERNS =
  /\bamid ongoing\b|as .* continues\b|years? after\b|decades? after\b|since the .* (war|conflict|invasion) began\b|still reeling\b|\banniversary of\b/i;

// Routine, expected, or de-escalatory activity that the topical KEYWORDS
// filter above will still catch (a port call by a US carrier mentions
// "troops"/a country by name, a peace summit mentions the same countries
// as the conflict it's resolving) but that isn't itself a threat — this is
// the layer that actually decides "is this worth reporting as risk," not
// just "does this article touch the topic." "X visits Y" is deliberately
// here too: a state visit reads as belonging to the visitor's country (the
// leader's name/demonym is usually what the headline leads with) but a
// routine visit is not a risk event for either country on its own.
const BENIGN_PATTERNS =
  /port call|goodwill visit|routine (patrol|visit|deployment)|arrives? (in|for)|\bvisits?\b|\bvisiting\b|state visit|travels? to|heads? to|trip to|(joint|annual|routine) (exercise|drill|training)(?!.*(warn|threat|escalat|tension|provoc))|peace talks|peace deal|ceasefire (holds|agreed|announced)|signs? (a |an )?(deal|agreement|treaty)|trade deal|summit|diplomatic visit|meets with|holds talks|anniversary|marks \d+ years?|art (festival|exhibition)|film festival|sporting event|championship/i;

const HIGH_SEVERITY = /nuclear (test|strike|weapon)|invasion|massacre|genocide|declared war/i;
// Expanded beyond the original "strike/attack/killed" set after reviewing
// real leaked-through feed output: military developments are often
// reported with a specific action verb ("cleared tunnels", "downed a
// drone", "seized the port") rather than the generic word "attack" —
// missing those was letting real incidents get treated the same as
// zero-signal topic-adjacent pieces by the MIN_SEVERITY gate below.
// Territory/kinetic-action verbs added for the Telegram incident filter
// (see assessIncidentSeverity below and src/lib/sources/telegram.ts) — raw
// milblogger/MoD channel posts favor this vocabulary ("recaptured",
// "struck", "neutralized", "liquidated") more than the strike/attack/killed
// wording RSS headlines typically use. Kept narrow enough not to fire on
// idiom ("struck a deal") or economic reporting ("hit record highs").
const MODERATE_SEVERITY =
  /\bstrikes?\b|missile (launch|fired|strike)|airstrike|\battack(ed|ing|s)?\b|killed|\bdead\b|casualties|wounded|injured|explosion|bombing|offensive|clashes?|\bcoup\b|martial law|seiz(ed|es|ing)(?!\s+(the\s+)?opportunity)|captur(ed|es|ing)(?!\s+(the\s+)?(moment|imagination|attention|essence|hearts?|spirit))|raid(ed|s)?|storm(ed|s)?|shot down|downed (a |an )?(drone|aircraft|jet|missile)|intercepted|cleared (tunnels|the area)|detained|arrested|evacuat(ed|es|ing|ion)|recaptur(ed|es|ing)|\bretook\b|\bretake\b|reclaim(ed|s|ing)|liberat(ed|es|ing)|repel(led|s)?|thwart(ed|s)?|destroy(ed|s)?|neutrali[sz]ed|eliminat(ed|es)|liquidat(ed|es)|struck\b(?! a (deal|balance|chord|pose))|hit by/i;
const MILD_SEVERITY =
  /warns?|threatens?|escalat|tension|sanctions? (imposed|announced)|protest|unrest|mobiliz|border incident/i;

// Severity defaults low (1 = Low) rather than moderate — an article merely
// touching a topic shouldn't read as meaningful risk on its own. Only
// explicit escalation language moves it up; nothing here defaults to
// "Elevated" or above without a real signal for it.
function keywordSeverity(text: string): number {
  if (HIGH_SEVERITY.test(text)) return 4;
  if (MODERATE_SEVERITY.test(text)) return 3;
  if (MILD_SEVERITY.test(text)) return 2;
  return 1;
}

// A severity-1 item has none of HIGH/MODERATE/MILD_SEVERITY's language at
// all — nothing in it reads as an incident, escalation, or even a
// warning/tension signal, just topical proximity to a flashpoint (a
// feature profile, a policy-lobbying story, a culture piece that happens
// to name a country). Reviewing real feed output turned up exactly this
// pattern slipping through: "The feminist organiser and her everyday
// rebellions", "Cafe at centre of Israel culture clash agrees to shut on
// Sabbath" — both passed BENIGN/ONGOING/NON_EVENT_TITLE checks (none of
// those patterns matched) while containing zero incident language. Gating
// on severity here — after category/BENIGN/ONGOING filtering, as the last
// check before an item becomes a stored, feed-visible event — is a
// precision-over-recall call: some real but mildly-worded developments
// get dropped along with the noise, but "breaking, not reflective" (the
// actual brief) needs that trade made in this direction, not the other.
const MIN_SEVERITY_TO_INCLUDE = 2;

// Title-first, same reasoning as country resolution below: a snippet
// mentioning Iran in passing (a related-coverage teaser, a source's other
// headlines) shouldn't file an unrelated UK-politics story under us-iran.
// Only falls back to scanning the full text when the title alone doesn't
// match any specific category, so a real category-relevant detail that's
// in the body but not the headline still gets caught.
function categorizeByKeywords(title: string, text: string): NewsCategory | "other" {
  for (const [category, pattern] of CATEGORY_MATCHERS) {
    if (pattern.test(title)) return category;
  }
  for (const [category, pattern] of CATEGORY_MATCHERS) {
    if (pattern.test(text)) return category;
  }
  return "other";
}

// Shared by classifyByKeywords below and src/lib/sources/telegram.ts's
// breaking-incident filter — the "is this actually a reported development,
// not routine/reflective noise" judgment shouldn't be reimplemented twice.
// Returns null for anything BENIGN/ONGOING_COVERAGE suppresses (unless it
// also carries real escalation language), otherwise the 1-4 severity score;
// callers decide their own inclusion floor (the general feed uses
// MIN_SEVERITY_TO_INCLUDE=2, Telegram's raw-channel filter uses a stricter
// bar — see TELEGRAM_MIN_SEVERITY in telegram.ts).
export function assessIncidentSeverity(text: string): number | null {
  const hasEscalation = HIGH_SEVERITY.test(text) || MODERATE_SEVERITY.test(text);

  // A benign/routine signal only suppresses the item if nothing in it also
  // reads as an actual escalation — "joint exercise" is routine on its own,
  // but "joint exercise cancelled after strikes" is not.
  if (BENIGN_PATTERNS.test(text) && !hasEscalation) return null;
  if (ONGOING_COVERAGE_PATTERNS.test(text) && !hasEscalation) return null;

  return keywordSeverity(text);
}

export function classifyByKeywords(item: RawItem): ClassifiedItem | null {
  if (NON_EVENT_TITLE_PATTERNS.test(item.title)) return null;

  const text = `${item.title} ${item.snippet}`;
  const severity = assessIncidentSeverity(text);
  if (severity === null || severity < MIN_SEVERITY_TO_INCLUDE) return null;

  const category = categorizeByKeywords(item.title, text);

  // The title is far more likely to name the actual subject of the story
  // than the snippet is — RSS snippets often carry source attribution or
  // secondary quotes ("...said the British ambassador") that can outrank
  // the real subject if the whole text is searched as one blob. Only fall
  // back to the snippet when the title itself names no recognized country.
  const resolvedCountry =
    resolveCountryFromText(item.title) ?? resolveCountryFromText(item.snippet);
  const country =
    resolvedCountry ??
    (category !== "other" ? CATEGORY_FALLBACK_COUNTRY[category] : undefined);
  if (!country) return null;

  const centroid = COUNTRY_CENTROIDS[country];
  if (!centroid) return null;

  return {
    id: 0, // overwritten by the caller, which tracks items by array index
    relevant: true,
    summary: item.title,
    category,
    location: centroid.name,
    country,
    lat: centroid.lat,
    lon: centroid.lon,
    severity,
  };
}
