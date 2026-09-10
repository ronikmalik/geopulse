// GDELT bulk-file events (src/lib/sources/gdeltBulk.ts) arrive as structured
// CAMEO fields (actor names, a 2-digit EventRootCode, GoldsteinScale), not a
// natural-language headline the way RSS/Telegram/the old DOC-API path do.
// classify.ts's severity/category logic (keywordSeverity, categorizeByKeywords)
// only ever looks at title+snippet TEXT — it has no separate code path for
// structured data, and deliberately isn't getting one here (see this file's
// header note in gdeltBulk.ts on why forking the severity engine per-source
// would be riskier than reusing the one already live-tested against real
// production headlines). So instead, this module synthesizes a plain-English
// sentence from the structured fields, chosen to land in the SAME keyword
// buckets a real headline about that kind of event would — using this app's
// own MODERATE_SEVERITY/MILD_SEVERITY vocabulary in classify.ts as the
// design target, not invented independently.
//
// Deliberately conservative: nothing here ever synthesizes HIGH_SEVERITY
// language (invasion/massacre/genocide/nuclear) — those claims need real
// specific evidence a bare CAMEO root code can't provide, and this app's own
// existing severity design already treats false positives on that tier as
// far more costly than under-scoring a genuinely severe event to MODERATE
// (3) instead of HIGH (4). The event still clears the inclusion bar either
// way; only the label differs.
export const CAMEO_ROOT_LABELS: Record<string, string> = {
  "01": "MAKE PUBLIC STATEMENT",
  "02": "APPEAL",
  "03": "EXPRESS INTENT TO COOPERATE",
  "04": "CONSULT",
  "05": "ENGAGE IN DIPLOMATIC COOPERATION",
  "06": "ENGAGE IN MATERIAL COOPERATION",
  "07": "PROVIDE AID",
  "08": "YIELD",
  "09": "INVESTIGATE",
  "10": "DEMAND",
  "11": "DISAPPROVE",
  "12": "REJECT",
  "13": "THREATEN",
  "14": "PROTEST",
  "15": "EXHIBIT FORCE POSTURE",
  "16": "REDUCE RELATIONS",
  "17": "COERCE",
  "18": "ASSAULT",
  "19": "FIGHT",
  "20": "USE UNCONVENTIONAL MASS VIOLENCE",
};

// One verb phrase per root code, hand-picked to match a real, specific
// pattern in classify.ts's HIGH_SEVERITY/MODERATE_SEVERITY/MILD_SEVERITY
// regexes (checked against that file directly, not guessed) — e.g. root 15
// uses "mobilizes forces", matching MODERATE_SEVERITY's bare "mobiliz".
// Root 14 (Protest) is handled specially below (goldstein-gated between two
// phrasings) rather than having one fixed entry here, since CAMEO's own
// protest sub-codes span from a peaceful demonstration to a violent riot
// and this root-level mapping can't see that distinction directly — using
// GoldsteinScale (more negative = more destabilizing) as the next-best
// signal for which end of that range a given event sits on. Roots 16 and 17
// are the exception to "matches a specific severity pattern" — see their
// own inline comments below for why they're deliberately generic instead.
const ROOT_VERB_PHRASE: Record<string, string> = {
  "01": "issues a statement about",
  "02": "appeals to",
  "03": "expresses intent to cooperate with",
  "04": "holds talks with",
  "05": "engages in diplomatic cooperation with",
  "06": "engages in material cooperation with",
  "07": "provides aid to",
  "08": "yields to a demand from",
  "09": "opens an investigation involving",
  "10": "issues a demand toward",
  "11": "disapproves of actions by",
  "12": "rejects a proposal from",
  "13": "threatens",
  "15": "mobilizes forces near",
  // 16 (REDUCE RELATIONS) and 17 (COERCE) are each a WIDE CAMEO root
  // spanning several distinct leaf actions (16: sever diplomatic ties, halt
  // negotiations, expel aid agencies/peacekeepers, among others; 17: impose
  // sanctions, blockade, curfew, martial law, give an ultimatum, among
  // others) that this app only has verified labels for at the root level,
  // not the specific leaf EventCode. An earlier version used "recalls its
  // ambassador from" / "imposes sanctions on" for the WHOLE root — live-
  // tested 2026-09-10 and found making a specific factual claim the
  // underlying leaf code often didn't support (e.g. "Police imposes
  // sanctions on Cuba" for what was likely a blockade/curfew-type action,
  // not sanctions). Deliberately generic here instead — accurate for the
  // whole root, at the cost of not matching classify.ts's MODERATE_SEVERITY
  // vocabulary (so these two roots now score severity 1 and are filtered
  // out downstream) until a verified leaf-code table lets this be both
  // specific and correct.
  "16": "reduces diplomatic relations with",
  "17": "takes coercive action against",
  "18": "attacks",
  "19": "is fighting",
  "20": "launches a major offensive against",
};

interface CameoEventRow {
  actor1Name: string | null;
  actor2Name: string | null;
  eventRootCode: string;
  goldsteinScale: number;
  actionLocationName: string | null;
}

function properCase(name: string): string {
  // CAMEO actor names arrive ALL CAPS ("UNITED STATES", "UNIDENTIFIED
  // ARMED GROUP") — title-casing reads far closer to a real headline than
  // shouting every word would, without needing a full proper-noun dataset.
  return name
    .toLowerCase()
    .split(" ")
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// Builds a plain-English title/snippet pair from one GDELT bulk event row.
// Returns null when there's not enough real signal to describe (no root
// code we recognize, or both actors are unidentified) — callers should
// drop the row rather than publish an empty-feeling description.
export function buildEventDescription(row: CameoEventRow): { title: string; snippet: string } | null {
  const actor1 = row.actor1Name ? properCase(row.actor1Name) : null;
  const actor2 = row.actor2Name ? properCase(row.actor2Name) : null;
  if (!actor1 && !actor2) return null;

  const root = row.eventRootCode;
  const location = row.actionLocationName ? ` in ${row.actionLocationName}` : "";
  const subject = actor1 ?? "Unidentified forces";

  let title: string;
  if (root === "14") {
    // Protest: goldstein <= -6 reads as the violent/suppressed end of the
    // range (matches classify.ts's MODERATE_SEVERITY "clash" — a riot or a
    // crackdown, not a peaceful march); above that, plain "protest" lands
    // in MILD_SEVERITY, correctly excluded on its own by MIN_SEVERITY_TO_
    // INCLUDE unless something else in the same item pushes it higher.
    // Handled as its own template (not the generic subject-verb-object
    // shape below) since a protest's natural "object" is whoever it's
    // clashing with or directed at, defaulting to security forces/the
    // government when Actor2 wasn't identified, rather than reading oddly
    // with no object at all.
    const target = actor2 ?? (row.goldsteinScale <= -6 ? "security forces" : "the government");
    title =
      row.goldsteinScale <= -6
        ? `${subject} clashes with ${target} during a protest${location}`
        : `${subject} holds a protest against ${target}${location}`;
  } else {
    const verbPhrase = ROOT_VERB_PHRASE[root];
    if (!verbPhrase) return null; // root 09 (Investigate) and others with no reliable severity signal fall through here
    // These are all genuinely bilateral actions (threaten/mobilize-near/
    // reduce-relations-with/coerce/attack/fight/mass-violence-against) — a
    // one-sided "X is fighting" with no named counterparty is exactly the
    // ambiguous, GDELT-extraction-noise shape live-testing surfaced
    // (2026-09-10: "Switzerland is fighting in Switzerland", "Portugal is
    // fighting in Turkey" — both had no Actor2 at all). Unlike root 14
    // (Protest, handled above), there's no sensible generic stand-in for
    // an unnamed opponent here, so these are dropped rather than guessed.
    if (!actor2) return null;
    title = `${subject} ${verbPhrase} ${actor2}${location}`.trim();
  }

  const snippet = `${CAMEO_ROOT_LABELS[root] ?? "Reported development"}: ${title}. Reported via GDELT's structured event stream (GoldsteinScale ${row.goldsteinScale.toFixed(1)}).`;

  return { title, snippet };
}
