// Rewritten 2026-09-10 after a user-caught bug: this module used to
// synthesize a plain-English title/snippet from GDELT's structured CAMEO
// fields (actor names + a templated action verb) for direct display — but
// that synthesized sentence was never the real headline of the article at
// the event's own URL, so clicking through showed a completely different
// real story than the card claimed. The fix (see pendingGdeltTitle.ts and
// gdeltBulk.ts's drainPendingGdeltTitles) is to fetch the REAL title from
// the article itself instead of guessing one — nothing in this app should
// ever again display a claim synthesized from structured data as if it
// were the article's own words.
//
// What's left here is much smaller: a cheap pre-filter deciding which
// candidates are even worth spending a real-title-fetch on (a bounded,
// real network resource), since fetching a title for every single CAMEO
// row GDELT records — including routine diplomatic statements/cooperation
// that would never clear classify.ts's severity floor regardless of what
// the real headline says — would waste that budget on rows overwhelmingly
// unlikely to ever go live.
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

// CAMEO's own QuadClass groups every root code under four primary
// classifications (GDELT 2.0 Event Codebook): 1=Verbal Cooperation,
// 2=Material Cooperation (roots 01-09), 3=Verbal Conflict, 4=Material
// Conflict (roots 10-20). Only the conflict tier is worth a real-title
// fetch — a genuine root 01-09 (statement/appeal/cooperation) story is
// exactly the "routine diplomacy, not an incident" case classify.ts's own
// BENIGN_PATTERNS/severity floor already excludes even from a REAL
// headline, so spending a fetch on it would only confirm what the root
// code already told us for free. Unlike the old synthesized-phrase
// version of this file, there's no need to hand-pick specific roots
// within the conflict tier anymore — a real fetched headline lets
// classify.ts's own severity engine judge each one on its actual words,
// not a guessed template.
const CONFLICT_TIER_ROOTS = new Set([
  "10",
  "11",
  "12",
  "13",
  "14",
  "15",
  "16",
  "17",
  "18",
  "19",
  "20",
]);

export function isWorthFetchingRealTitle(eventRootCode: string): boolean {
  return CONFLICT_TIER_ROOTS.has(eventRootCode);
}
