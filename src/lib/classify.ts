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
//
// 2026-09-05: user flagged that political-instability and humanitarian —
// this app's own core pillars — were getting missed for countries outside
// the five named flashpoints, specifically because this net was tuned to
// their vocabulary (missile/airstrike/nuclear/drone strike) rather than
// the words real wire coverage actually uses for instability/humanitarian
// stories elsewhere: "Zimbabwe's ruling party wins disputed election amid
// fraud allegations," "Peru's president faces impeachment vote after
// corruption scandal," and "Haiti gang violence displaces thousands" all
// failed this net entirely before reaching severity scoring — not a
// Western bias by intent, just narrower coverage than the two pillars
// this is supposed to feed. "gunmen"/"militant(s)" added because African/
// Latin American attack coverage routinely uses these instead of the
// generic "terrorist"/"extremist" already here (e.g. Boko Haram/ISWAP/
// al-Shabaab reporting) — bare "displaced"/"displacement" added to match
// what CATEGORY_MATCHERS' humanitarian pattern below already accepts, so
// this shallower gate isn't stricter than the deeper logic it feeds.
// 2026-09-05, second pass: user asked for a genuine country-by-country
// sweep, not just the generic vocabulary above — "notice how we were
// missing key stuff for nigeria, we are probably missing stuff for every
// country... find the buzzwords we need to include." Went region by
// region for every country/theater with an active named insurgency,
// cartel, or armed political-instability actor NOT already covered by a
// flashpoint keyword or the generic terms above. Named groups matter
// specifically because real wire coverage of e.g. a Boko Haram attack
// routinely never uses generic words like "terrorist" at all — it names
// the group instead — so without this list, isLikelyGeopolitical has no
// way to recognize the story as a candidate regardless of how the
// severity/category logic downstream would otherwise handle it.
//
// Short acronyms that collide with unrelated common meanings are
// deliberately EXCLUDED here even when the group is real and significant
// (e.g. bare "RSF" also means Reporters Sans Frontières/Reporters Without
// Borders in press-freedom coverage; bare "ADF" also means Australia's
// Defence Force) — full names are used instead, safe because they're
// multi-word. This mirrors the file's existing caution around bare
// short tokens (see countryNames.ts's US/UK/UAE case-sensitivity
// handling) applied one level earlier, at the topical gate itself.
// 2026-09-05, third pass: user asked specifically about Iran's "Axis of
// Resistance" network — Hezbollah/Hamas/Houthis were already covered
// (flashpoint vocabulary), but the Iran-aligned Iraqi militias that
// routinely claim attacks on US forces (and get named, not described
// generically) had zero coverage: Kata'ib Hezbollah, Asa'ib Ahl al-Haq,
// Harakat Hezbollah al-Nujaba, and the umbrella name "Islamic Resistance
// in Iraq" these groups collectively claim attacks under. Same for IRGC/
// Quds Force itself (Iran's own military-industrial actor abroad — a
// headline like "IRGC commander killed in strike on Damascus" doesn't
// necessarily say "Iran" at all) and Palestinian Islamic Jihad (a
// distinct Gaza-based group from Hamas, also Axis-of-Resistance-aligned).
// ISIS-Sinai and Syrian Democratic Forces added in the same pass as
// adjacent Middle East gaps the same review surfaced.
const IRAN_PROXY_ACTORS =
  "irgc|quds force|revolutionary guard|islamic jihad|kata'?ib hezbollah|asa'?ib ahl al-haq|al-nujaba|islamic resistance in iraq";

const REGIONAL_ACTORS =
  "boko haram|iswap|jnim|al-shabaab|al shabaab|tplf|\\bm23\\b|allied democratic forces|codeco|s[ée]l[ée]ka|anti-balaka|rapid support forces|houthi|ansar allah|hayat tahrir al-sham|\\bhts\\b|syrian democratic forces|islamic state|\\bisis\\b|isis-sinai|sinai province|al-qaeda|\\btaliban\\b|isis-k|khorasan province|tehrik-i-taliban|pakistani taliban|naxalite|maoist rebels|lashkar-e-taiba|jaish-e-mohammed|\\bpkk\\b|abu sayyaf|new people's army|arakan army|sendero luminoso|\\bfarc\\b|clan del golfo|sinaloa cartel|jalisco new generation|\\bms-13\\b|barrio 18|"
  + IRAN_PROXY_ACTORS;

const KEYWORDS = new RegExp(
  "iran|israel|gaza|palestin|hamas|hezbollah|lebanon|russia|ukraine|kremlin|putin|zelensk|taiwan|beijing|china.*military|north korea|kim jong|pyongyang|missile|airstrike|nuclear|sanctions|troops|invasion|ceasefire|drone strike|coup|martial law|insurgency|rebel|militia|terroris|extremis|militant|gunmen|jihadist|paramilitary|warlord|civil war|ethnic cleansing|massacre|cartel|uprising|unrest|crackdown|junta|regime|embargo|blockade|airspace violation|border clash|skirmish|mobiliz|annex|separatist|secession|genocide|war crime|refugee crisis|mass displacement|\\bdisplaced\\b|displacement|gang violence|organized crime|cyberattack|state-sponsored hacking|impeach|disputed election|election fraud|corruption scandal|opposition leader|supreme court|constitutional court|court (rules?|ruling|strikes down|upholds|blocks)|"
    + REGIONAL_ACTORS,
  "i",
);

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
  // Iran-proxy actors checked here, not just bare "iranian|iran" — a
  // headline naming Kata'ib Hezbollah or the IRGC directly often never
  // says "Iran" at all, and checked before israel-palestine below because
  // "Kata'ib Hezbollah" would otherwise collide with that matcher's bare
  // "hezbollah" (a real find from the 2026-09-05 Axis-of-Resistance
  // review: "Kata'ib Hezbollah claims rocket attack on US base in Iraq"
  // was categorizing as israel-palestine, an Iraq/Iran story with no
  // Israel-Palestine connection at all).
  [
    "us-iran",
    /iranian|\biran\b|irgc|quds force|revolutionary guard|kata'?ib hezbollah|asa'?ib ahl al-haq|al-nujaba|islamic resistance in iraq/i,
  ],
  [
    "russia-ukraine",
    /russian|\brussia\b|kremlin|putin|ukrainian|\bukraine\b|zelensky|zelenskyy|\bkyiv\b/i,
  ],
  ["israel-palestine", /\bisrael\b|\bgaza\b|\bpalestin|\bhamas\b|\bhezbollah\b/i],
  ["china-taiwan", /taiwanese|\btaiwan\b/i],
  ["north-korea", /north korea|pyongyang|kim jong/i],
  [
    "political-instability",
    // impeach/disputed-election/corruption-scandal added 2026-09-05 — see
    // the KEYWORDS comment above for why (real examples like "Peru's
    // president faces impeachment vote after corruption scandal" and
    // "Zimbabwe's ruling party wins disputed election amid fraud
    // allegations" weren't reaching this matcher at all before that fix,
    // and wouldn't have categorized correctly even if they had).
    /\bcoup\b|martial law|state of emergency|election fraud|disputed election|government collapse|ousted|overthrown|impeach(ment|ed)?|corruption scandal|supreme court|constitutional court|court (rules?|ruling|strikes down|upholds|blocks)/i,
  ],
  [
    "humanitarian",
    // "outbreak" bare, not just "disease outbreak" — a real synthetic-test
    // case ("Cholera Outbreak Kills Dozens...") fell through to "other"
    // because MODERATE_SEVERITY (above) already accepts bare "outbreak"
    // but this category matcher required the exact phrase "disease
    // outbreak", which real headlines naming the specific disease
    // (cholera, measles, Ebola outbreak) don't use.
    //
    // "gang violence"/"organized crime" added 2026-09-05 — a real example
    // ("Haiti gang violence displaces thousands from the capital")
    // describes a genuine humanitarian displacement crisis without using
    // any of the phrases already here.
    /famine|food insecurity|malnutrition|refugee|displaced|displacement|humanitarian crisis|humanitarian emergency|\boutbreak\b|epidemic|exodus|flee(s|ing)?|gang violence|organized crime/i,
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
// "What the latest flare-up between the U.S and Iran means" (a real GDELT
// hit, 2026-09-04) — a bare "what ... means" analysis construction with no
// colon and none of the specific "who is/why did/what happened" phrasings
// above, so it slipped through both this pattern and (since it carried no
// escalation vocabulary) the severity floor alone wouldn't have been a
// reliable second line of defense for every future case like it. Added as
// its own alternation rather than folded into the "what happened" branch
// since "what X means" is a distinct, common analysis-piece construction.
const NON_EVENT_TITLE_PATTERNS =
  /^(what to know|explainer|analysis|opinion|op-ed|q&a|in pictures|in photos|photos:|the backstory|timeline:|explained:|commentary|roundup|special report|deep dive|backgrounder|primer)\b|explainer$|^(who is|who are|why is|why did|why does|how is|how did|how does|what happened|what to make of)\b|:\s*(what to know|what happened|explained|explainer|analysis|q&a|commentary)\b|^what\b.{0,80}\bmeans?\b/i;

// GDELT-specific (see classifyGdeltItem below): press releases/advisories
// from advocacy orgs and media-criticism pieces that argue an outlet got
// something wrong — neither is a report that anything happened. Found live
// (2026-09-04): "PRESS ADVISORY: Kite Framing: CAMERA Urges Media Outlets
// to Recall History of Destructive Attacks..." scored severity 3 purely
// because "Attacks" appeared in a historical-reference clause, and "The
// American Prospect Features Inaccurate Claims about the State of Israel
// and American Jews" is pure media criticism with no incident at all
// (scored severity 1, but this pattern exists as a belt-and-suspenders
// check independent of severity — a press advisory that happened to use
// stronger language wouldn't be safe to let the floor alone catch).
const EDITORIAL_PATTERNS =
  /^press advisory\b|\burges?\s+(media|outlets|journalists)\b|\bfeatures?\s+(inaccurate|misleading|false)\s+claims?\b|\brepeats?\s+(inaccurate|misleading|false)\s+claims?\b/i;

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
  /nuclear (test|strike|weapon)|invad(ed|es|ing)|launch(ed|es)? (a |an )?invasion|(?<!october 7[,\s]{0,4})(?<!hamas\s)massacre|genocide|ethnic cleansing|declared war/i;
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
// 2026-09-05: found via the regional-buzzwords deep dive — several verbs
// here only matched a SPECIFIC inflection, not the bare/base form, a real
// bug that's been silently dropping ordinary headlines this whole
// session, not just the new regional examples that surfaced it:
// "clashes?" is "clashe" + optional "s" (the "?" only applies to the one
// preceding character), so it matched "clashes"/"clashe" but never bare
// "clash" — "TPLF forces clash with Ethiopian troops" scored severity 1.
// Same gap for "killed" (never matched present-tense "kills," and bare
// "kill" is needed too — "gunmen kill police chief" is plural-subject
// present tense with no suffix at all) and "captur(ed|es|ing)" (never
// matched bare "capture"). Fixed by grouping the suffix instead of just
// the last letter — "kill" specifically gets idiom exclusions the same
// way "struck"/"seized"/"captured" already do above, since bare "kill" is
// common outside conflict reporting ("kill the bill," "kill switch,"
// "killing it" as praise). Also added: shell(ed/ing/s)
// (artillery bombardment), kidnap(ped/ping/s), ambush(ed/es/ing) — all
// real, common conflict-reporting verbs missing entirely; "cartel
// violence" as its own compound phrase rather than bare "violence" (too
// broad — would fire on unrelated domestic-violence/gun-violence crime
// stories that aren't conflict-relevant).
//
// 2026-09-05, third pass (Axis of Resistance review): "fired rockets"/
// "rocket fire"/"rocket attack" added — extremely common Israel-Gaza
// phrasing ("Palestinian Islamic Jihad fires rockets toward Israeli
// border towns") that had no severity signal at all before. "drone
// strike" added as its own compound — KEYWORDS already treated it as a
// topical signal, but MODERATE_SEVERITY only had one-word "airstrike"
// and "downed a drone" (a drone being shot down, the opposite direction),
// never a strike carried out BY a drone. "targeted in/by a strike/attack/
// raid" added narrowly (not bare "targeted," which is common outside
// conflict reporting — "targeted advertising," "targeted approach").
// Retaliation-vow pattern broadened from "vows" only to also accept
// "threatens" — "Asa'ib Ahl al-Haq threatens retaliation against US
// troops" is the same real-threat signal as classify.ts's Telegram-
// specific DIRECT_THREAT_PATTERN already recognizes, just missing here
// for RSS/GDELT's own severity scoring.
const MODERATE_SEVERITY =
  /\bstrikes?\b|missile (launch|fired|strike)|airstrike|\battack(ed|ing|s)?\b|kill(s|ed|ing)?(?!\s+(the\s+)?(bill|switch|time|mood|buzz|vibe|it))|\bdead\b|casualties|wounded|injured|explosion|bombing|offensive|(?<!culture )clash(es)?|fir(ed|es|ing) rockets?|rocket (fire|attack)|drone strike|targeted (in|by) (a |an )?(strike|attack|raid)|\bcoup\b|martial law|seiz(ed|es|ing)(?!\s+(the\s+)?opportunity)|captur(e|ed|es|ing)(?!\s+(the\s+)?(moment|imagination|attention|essence|hearts?|spirit))|raid(ed|s)?|storm(ed|s)?|shot down|downed (a |an )?(drone|aircraft|jet|missile)|intercepted|cleared (tunnels|the area)|detained|arrested|evacuat(ed|es|ing|ion)|recaptur(ed|es|ing)|\bretook\b|\bretake\b|reclaim(ed|s|ing)|liberat(ed|es|ing)|repel(led|s)?|thwart(ed|s)?|destroy(ed|s)?|neutrali[sz]ed|eliminat(ed|es)|liquidat(ed|es)|struck\b(?! a (deal|balance|chord|pose))|hit by|shell(ed|ing|s)?|kidnap(ped|ping|s)?|ambush(ed|es|ing)?|mobiliz|border incident|state of emergency|election fraud|disputed election|government collapse|\bousted\b|\boverthrown\b|power grab|parliament dissolved|resign(ed|s)? (amid|under|following)|impeach(ment|ed)?|corruption scandal|gang violence|cartel violence|organized crime|court (rules?|ruling|strikes down|upholds|blocks)|famine|malnutrition|displaced|displacement|refugee crisis|humanitarian crisis|humanitarian emergency|disease outbreak|epidemic|\bexodus\b|flee(s|ing)?|death toll|\boutbreak\b|\bsanctions?\b|expel(led|s)?|recall(ed|s)? (its |the )?ambassador|sever(ed|s)? (diplomatic )?ties|withdr(aw|ew|awn|awing)s? from (the )?(treaty|deal|agreement|pact)|pulls? out of (the )?(treaty|deal|agreement|pact)|(vows?|threatens?)[^.]{0,30}(sanctions|retaliation|reprisal)|nationaliz(ed|es|ing)|expropriat(ed|es|ing)|(?<!(stop|end|halt) the )\bfighting\b|push(ed|es)? (toward|into|on)|advanc(ed|es|ing) (toward|into|on)/i;
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

// GDELT-specific — meaningfully looser than classifyByKeywords below (no
// MIN_SEVERITY_TO_INCLUDE=3 floor, no BENIGN_PATTERNS/ONGOING_COVERAGE_
// PATTERNS suppression), but NOT zero-floor. First pass (2026-09-04)
// accepted any severity including 1, on "let them through as long as it's
// new info about what's happening in a country" — that let real noise
// through: "China and Iran Commit to Broadening Strategic Partnership
// Across Various Sectors" and "Israel Armed Argentina Against Britain in
// 1982 Now Putin, Trump and Netanyahu Encourage Milei..." both scored
// severity 1 (by keywordSeverity's own definition, severity 1 means NONE
// of HIGH/MODERATE/MILD_SEVERITY matched — zero incident, escalation, or
// even warning/tension language, just topical proximity), and the user's
// direct follow-up ("too much shit is filtering though... make sure it's
// very relevant to the country or geopolitical risk, not editorial... it
// needs to be live breaking news, not some random analysis") confirmed
// that's exactly the "doesn't influence anything" content to cut. Floor
// raised to MILD_SEVERITY (>=2) — still well short of RSS/Telegram's
// MODERATE+ bar (>=3), so routine-but-real developments with at least a
// warn/threaten/escalate/tension/protest/unrest signal still get through,
// but bare topic-adjacent mentions with no signal at all don't.
// EDITORIAL_PATTERNS is a separate, severity-independent check — a press
// advisory or media-criticism piece isn't safe to let through just because
// it happens to score high (see its own comment above: the CAMERA press
// advisory scored severity 3 from "Attacks" appearing in a historical
// reference clause, not from reporting anything happening).
export function classifyGdeltItem(item: RawItem): ClassifiedItem | null {
  if (NON_EVENT_TITLE_PATTERNS.test(item.title)) return null;
  if (EDITORIAL_PATTERNS.test(item.title)) return null;

  const text = `${item.title} ${item.snippet}`;
  if (DEFINITELY_ONGOING_PATTERNS.test(text)) return null;
  if (RHETORICAL_ARGUMENT_PATTERNS.test(text)) return null;

  const severity = keywordSeverity(text);
  if (severity < 2) return null;

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
