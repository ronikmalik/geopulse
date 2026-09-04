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
// 2026-09-04: found via the event-dedup work — the same real event (a
// Russian drone strike on Ukraine's SBU HQ) split across BOTH "other" and
// "russia-ukraine" because \brussia\b requires the exact word "Russia" and
// doesn't match "Russian" (the far more common adjective form in
// headlines: "Russian drone strikes..."), and there was no Ukraine-side
// keyword at all — a headline leading with "Ukraine"/"Kyiv"/"Zelensky"
// and never naming Russia by its noun form had nothing to match. Same
// \bWORD\b-vs-adjective gap existed for us-iran ("Iranian") and
// china-taiwan ("Taiwanese"). Category is what src/lib/eventDedup.ts
// groups candidates by before comparing content similarity, so a
// category miss doesn't just mis-bucket a story for display — it silently
// prevents genuine duplicates of it from ever being detected at all.
const CATEGORY_MATCHERS: [NewsCategory, RegExp][] = [
  ["us-iran", /iranian|\biran\b/i],
  [
    "russia-ukraine",
    /russian|\brussia\b|kremlin|putin|ukrainian|\bukraine\b|zelensky|zelenskyy|\bkyiv\b/i,
  ],
  ["israel-palestine", /\bisrael\b|\bgaza\b|\bpalestin|\bhamas\b|\bhezbollah\b/i],
  ["china-taiwan", /taiwanese|\btaiwan\b/i],
  ["north-korea", /north korea|pyongyang|kim jong/i],
  [
    "political-instability",
    /\bcoup\b|martial law|state of emergency|election fraud|government collapse|ousted|overthrown/i,
  ],
  [
    "humanitarian",
    // "outbreak" bare, not just "disease outbreak" — a real synthetic-test
    // case ("Cholera Outbreak Kills Dozens...") fell through to "other"
    // because MODERATE_SEVERITY (above) already accepts bare "outbreak"
    // but this category matcher required the exact phrase "disease
    // outbreak", which real headlines naming the specific disease
    // (cholera, measles, Ebola outbreak) don't use.
    /famine|food insecurity|malnutrition|refugee|displaced|displacement|humanitarian crisis|humanitarian emergency|\boutbreak\b|epidemic|exodus|flee(s|ing)?/i,
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
// commentary/roundup/special report/deep dive/backgrounder/primer/op-ed
// added alongside the original set — same headline-convention logic, just
// more of the genre, in response to the user's explicit push for a much
// higher "is this actually breaking" bar after the RSS outlet expansion
// (2026-09-04): "Definitely not reflection pieces on events that happened
// in the past or analyses."
const NON_EVENT_TITLE_PATTERNS =
  /^(what to know|explainer|analysis|opinion|op-ed|q&a|in pictures|in photos|photos:|the backstory|timeline:|explained:|commentary|roundup|special report|deep dive|backgrounder|primer)\b|explainer$|^(who is|who are|why is|why did|why does|how is|how did|how does|what happened|what to make of)\b|:\s*(what to know|what happened|explained|explainer|analysis|q&a|commentary)\b/i;

// Coverage of an ongoing/pre-existing situation rather than a fresh
// development — softer signals that only suppress when nothing else in
// the text also reads as an actual fresh escalation (see hasEscalation in
// assessIncidentSeverity below) — "amid ongoing tension" is routine on its
// own, but "amid ongoing tension, X strikes Y today" is not.
const ONGOING_COVERAGE_PATTERNS =
  /\bamid ongoing\b|as .* continues\b|since the .* (war|conflict|invasion) began\b|still reeling\b|\banniversary of\b/i;

// "X years/decades after Y" and its 2026-09-04 siblings (months-into/
// one-year-since/year-in-review/look-back-at) are a much stronger,
// near-deterministic "this is a retrospective" marker than the softer
// ONGOING_COVERAGE_PATTERNS above — strong enough that they suppress
// UNCONDITIONALLY, without the "unless it also has escalation language"
// carve-out. That carve-out exists because a routine-activity word and a
// fresh-escalation word can legitimately coexist ("joint exercise
// cancelled after strikes"), but a retrospective's whole subject IS
// escalation-tier vocabulary by definition — "Years After the Famine,
// Ethiopia Still Struggles to Recover" was incorrectly kept by a synthetic
// test because "famine" (added to MODERATE_SEVERITY the same day)
// satisfied the softer carve-out and defeated the "years after" signal
// entirely. Deliberately NOT adding bare "so far" or "to date" here or
// above: those phrases show up constantly INSIDE genuinely breaking
// articles as a live-count qualifier ("at least 40 killed so far in the
// strikes"), so blocking them would cut real breaking news, not just
// retrospectives.
const DEFINITELY_ONGOING_PATTERNS =
  /years? after\b|decades? after\b|months? into (the )?(war|conflict|invasion)\b|\bone year (since|on|after)\b|\byear in review\b|\blook(s)? back at\b/i;

// Same unconditional-suppression reasoning as DEFINITELY_ONGOING_PATTERNS
// above, for a different failure mode: state-media/propaganda commentary
// that argues a broad political characterization rather than reporting a
// specific new incident, but happens to reference real conflict
// vocabulary while doing it ("outrageous lie... pointing to a long
// history of attacks") — which satisfies the softer BENIGN_PATTERNS
// carve-out below and defeats it, the same way "famine" did for the
// ONGOING case. Found 2026-09-04 auditing Iran state-media Telegram
// channels at the user's request ("so much junk is making it through,
// straight propaganda... focus on direct reportings on attacks... not
// the propaganda junk"): a real Press TV post — "Gilbert Doctorow says
// the US claims that it never targets civilians are an outrageous lie,
// pointing to a long history of attacks..." — passed at severity 3
// despite being a named commentator's opinion, not a report that
// anything specific just happened. This targets the recognizable
// rhetorical-argument register (calling something a lie/hypocrisy/
// propaganda/double standard, "so-called" framing) rather than trying to
// detect "is this a pundit" structurally, which "IRGC commander says
// [strike] occurred" (legitimate direct reporting, same "X says Y"
// shape) would false-positive on.
const RHETORICAL_ARGUMENT_PATTERNS =
  /(is|are) (an? )?outrageous lies?|(is|are) a lie\b|(is|are) lies\b|smacks of hypocrisy|(is|are) (pure |sheer )?hypocrisy|(is|are) (pure |sheer )?propaganda|double standards?|so-called\b/i;

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

// "invasion" was a bare noun here originally, and it broke on real feed
// output (2026-09-04): a Moscow Times piece about a Russian ambassador's
// tenure ending scored Extreme severity purely because its snippet
// mentioned "the full-scale invasion of Ukraine" as scene-setting
// background — four-plus years in, that exact phrase is now almost always
// a historical reference, not a report of a fresh invasion starting.
// Requiring an active verb form (invades/invaded/invading, launches/
// launched an invasion) instead of the bare noun catches genuinely fresh
// invasion reporting while no longer matching backward-looking mentions.
//
// "massacre" had the identical problem, caught in the same review pass: a
// Haaretz piece analyzing Netanyahu's election strategy ("pivots to
// conspiracy theories") scored Extreme because its snippet referenced
// "the 2023 Hamas massacre" as background — October 7 has become a named
// historical event referenced in nearly every Israel-Palestine political
// analysis, the same way "the invasion" has for Russia-Ukraine. Excluding
// the two specific stale-reference forms actually observed (preceded by
// "October 7" or "Hamas") rather than removing "massacre" outright, which
// would also lose genuinely fresh massacre reports that don't happen to
// also use "killed"/"dead"/"casualties".
const HIGH_SEVERITY =
  /nuclear (test|strike|weapon)|invad(ed|es|ing)|launch(ed|es)? (a |an )?invasion|(?<!october 7[,\s]{0,4})(?<!hamas\s)massacre|genocide|declared war/i;
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
// Political-instability and humanitarian incident language added
// 2026-09-04 alongside the MIN_SEVERITY_TO_INCLUDE bar-raise below. Before
// this, a headline like "Government Collapses After Election Fraud
// Allegations" or "500,000 Displaced by Flooding" would categorize
// correctly (categorizeByKeywords already matched these exact phrases for
// political-instability/humanitarian) but scored severity 1 and got
// dropped anyway, because the category matchers and the severity matchers
// were never kept in sync — those two categories were structurally
// starved regardless of where the inclusion bar sat. mobiliz/border
// incident moved up from MILD: a military mobilization or a border
// incident is a concrete reported development, not rhetoric, and the
// user's explicit ask includes "military updates (show of strengths,
// etc.)". Bare "refugee"/"displaced" alone were deliberately left OUT
// here — too easily true of a passing mention in an unrelated story;
// "refugee crisis", "displaced"+numeric-impact framing, "exodus", and
// active "flee(ing)" read as an actual event happening, which is the bar.
// Concrete-non-violent-action terms added 2026-09-04 after the user
// corrected the inclusion framework: "exclude if it is not a live breaking
// event... it does not necessarily have to be conventional conflict...
// if the falklands stuff was a LIVE breaking event that just happened
// then u include it, even if it not an ambush or invasion or something."
// (See the third pass below for "fighting" and its exclusion.)
// The bar was never meant to be "is this violent/conflict-coded" — it's
// "did a concrete, official action just happen" — and sanctions actually
// being imposed, a diplomat being expelled, a country pulling out of a
// treaty are exactly that, even with zero kinetic content. "sanctions
// imposed/announced" moved here from MILD for the same reason.
//
// 2026-09-04, second pass: user explicitly said false positives beat
// false negatives here — "if you are unsure if it crosses our threshold,
// just put it in" — after I'd flagged (but deliberately not fixed) that
// "sanctions" used as a verb ("US sanctions Turkey-based bank over Iran
// ties") wasn't caught by the imposed/announced/unveiled/imposes
// requirement, and confirmed "i like the sanctions article." Bare
// \bsanctions?\b replaces that requirement entirely — accepting that a
// pure policy-discussion piece ("Sanctions Bill Stalls in Congress") now
// also passes, per the explicit new instruction to favor recall here.
//
// 2026-09-04, third pass: user flagged a real Yemen headline — "Yemen's
// Houthis Push Toward Red Sea Strait as Ground Fighting Escalates" — a
// genuine, significant military advance that scored severity 2 (only
// "escalat" matched) and, under today's bar, would be silently EXCLUDED
// entirely rather than merely under-scored. Neither "fighting" (actual
// combat, not just "tension") nor territorial-advance phrasing ("push
// toward", "advancing on") had ever been added, despite the user's
// original "military updates (show of strength)" inclusion criterion
// covering exactly this. Added bare "fighting" and push/advance-toward
// constructions — then immediately live-tested against real current
// headlines (same discipline as every change in this file) and found
// bare "fighting" pulling in a real false positive: "Trump wants to stop
// the fighting. Iran has trouble knowing when to quit" — a Haaretz
// opinion column, not a breaking report, that NON_EVENT_TITLE_PATTERNS
// doesn't catch (no "opinion:" prefix). "stop/end/halt the fighting" is a
// recognizable policy/editorial framing distinct from an actual report of
// fighting happening ("ground fighting escalates", "heavy fighting
// continues") — excluded via lookbehind rather than dropping "fighting"
// entirely, which would have reintroduced the original Yemen gap.
const MODERATE_SEVERITY =
  /\bstrikes?\b|missile (launch|fired|strike)|airstrike|\battack(ed|ing|s)?\b|killed|\bdead\b|casualties|wounded|injured|explosion|bombing|offensive|clashes?|\bcoup\b|martial law|seiz(ed|es|ing)(?!\s+(the\s+)?opportunity)|captur(ed|es|ing)(?!\s+(the\s+)?(moment|imagination|attention|essence|hearts?|spirit))|raid(ed|s)?|storm(ed|s)?|shot down|downed (a |an )?(drone|aircraft|jet|missile)|intercepted|cleared (tunnels|the area)|detained|arrested|evacuat(ed|es|ing|ion)|recaptur(ed|es|ing)|\bretook\b|\bretake\b|reclaim(ed|s|ing)|liberat(ed|es|ing)|repel(led|s)?|thwart(ed|s)?|destroy(ed|s)?|neutrali[sz]ed|eliminat(ed|es)|liquidat(ed|es)|struck\b(?! a (deal|balance|chord|pose))|hit by|mobiliz|border incident|state of emergency|election fraud|government collapse|\bousted\b|\boverthrown\b|power grab|parliament dissolved|resign(ed|s)? (amid|under|following)|famine|malnutrition|displaced|displacement|refugee crisis|humanitarian crisis|humanitarian emergency|disease outbreak|epidemic|\bexodus\b|flee(s|ing)?|death toll|\boutbreak\b|\bsanctions?\b|expel(led|s)?|recall(ed|s)? (its |the )?ambassador|sever(ed|s)? (diplomatic )?ties|withdr(aw|ew|awn|awing)s? from (the )?(treaty|deal|agreement|pact)|pulls? out of (the )?(treaty|deal|agreement|pact)|vows?[^.]{0,30}(sanctions|retaliation|reprisal)|nationaliz(ed|es|ing)|expropriat(ed|es|ing)|(?<!(stop|end|halt) the )\bfighting\b|push(ed|es)? (toward|into|on)|advanc(ed|es|ing) (toward|into|on)/i;
const MILD_SEVERITY =
  /warns?|threatens?|escalat|tension|protest|unrest/i;

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

// Raised from 2 (MILD) to 3 (MODERATE) on 2026-09-04, after expanding the
// RSS outlet list to 26 sources — more outlets meant more volume of
// exactly the "technically on-topic, not actually breaking" content this
// gate exists to catch, and the user was explicit that the bar needed to
// be meaningfully higher, not just wider coverage: "there is too much
// fluff... make sure the news we get is truly live events or recent
// events... it should be a proxy for gdelt/telegram/truly live updates."
// MILD_SEVERITY (warnings, threats, "tension," sanctions announcements,
// bare protest/unrest) is exactly the rhetorical/diplomatic-noise
// register the complaint was about — a country "warning" another, or
// generic "tension," reads as analysis-adjacent, not a live incident.
// This now matches TELEGRAM_MIN_SEVERITY in src/lib/sources/telegram.ts
// (which already used 3) — one consistent bar across GDELT, RSS, and
// Telegram, all three sourced through this same assessIncidentSeverity.
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
export const MIN_SEVERITY_TO_INCLUDE = 3;

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

// Used by src/lib/classificationArchive.ts's vocabulary-candidate report —
// a word/phrase already covered by any severity tier isn't a useful
// "new vocabulary" suggestion, so this lets that report filter candidates
// against the actual live patterns instead of a hand-maintained exclude
// list that could silently drift out of sync with the regexes above.
export function isKnownIncidentVocabulary(phrase: string): boolean {
  return (
    HIGH_SEVERITY.test(phrase) ||
    MODERATE_SEVERITY.test(phrase) ||
    MILD_SEVERITY.test(phrase) ||
    BENIGN_PATTERNS.test(phrase)
  );
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
  // Checked first and unconditionally — see DEFINITELY_ONGOING_PATTERNS /
  // RHETORICAL_ARGUMENT_PATTERNS above for why these bypass the
  // hasEscalation carve-out entirely.
  if (DEFINITELY_ONGOING_PATTERNS.test(text)) return null;
  if (RHETORICAL_ARGUMENT_PATTERNS.test(text)) return null;

  const hasEscalation = HIGH_SEVERITY.test(text) || MODERATE_SEVERITY.test(text);

  // A benign/routine signal only suppresses the item if nothing in it also
  // reads as an actual escalation — "joint exercise" is routine on its own,
  // but "joint exercise cancelled after strikes" is not.
  if (BENIGN_PATTERNS.test(text) && !hasEscalation) return null;
  if (ONGOING_COVERAGE_PATTERNS.test(text) && !hasEscalation) return null;

  return keywordSeverity(text);
}

// GDELT-specific, deliberately looser than classifyByKeywords below. Per
// the user's explicit instruction (2026-09-04): "let the gdelt updates be
// far less restrictive than the others. as long as it is new info and
// about what is happening in a country let them through." RSS/Telegram
// need the full severity + BENIGN/ONGOING suppression stack because they're
// a general firehose where most volume is topic-adjacent noise (features,
// op-eds, routine diplomacy). GDELT hits come from CATEGORY_QUERIES —
// already scoped to a specific flashpoint topic at the query level — so a
// result is inherently "what is happening" in that topic; there's much
// less noise to filter out, and none of MIN_SEVERITY_TO_INCLUDE or
// BENIGN_PATTERNS/ONGOING_COVERAGE_PATTERNS is applied here. What's still
// excluded is narrower and answers a different question — "is this
// actually new information" — not "is this escalation-worthy": pure
// explainer/opinion headlines, unconditional retrospectives ("years
// after..."), and rhetorical-argument pieces are still not news of
// something happening, they're commentary on something that already did.
export function classifyGdeltItem(item: RawItem): ClassifiedItem | null {
  if (NON_EVENT_TITLE_PATTERNS.test(item.title)) return null;

  const text = `${item.title} ${item.snippet}`;
  if (DEFINITELY_ONGOING_PATTERNS.test(text)) return null;
  if (RHETORICAL_ARGUMENT_PATTERNS.test(text)) return null;

  const severity = keywordSeverity(text);
  const category =
    (item.gdeltCategory as NewsCategory | undefined) ??
    categorizeByKeywords(item.title, text);

  const resolvedCountry =
    resolveCountryFromText(item.title) ?? resolveCountryFromText(item.snippet);
  const country =
    resolvedCountry ??
    (category !== "other" ? CATEGORY_FALLBACK_COUNTRY[category] : undefined);
  if (!country) return null;

  const centroid = COUNTRY_CENTROIDS[country];
  if (!centroid) return null;

  return {
    id: 0,
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
