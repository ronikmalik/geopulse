// Pre-translation triage for Telegram's non-English channels (2026-09-10,
// user request: translation budget "getting eaten up quite quickly each
// day" — real data showed 81.5% of translated posts get DROPPED after
// classification anyway, since classify.ts's incident-language bar
// (CONFLICT_ACTION_PATTERN/DIRECT_THREAT_PATTERN in src/lib/sources/
// telegram.ts) only runs on English/translated text — every post had to
// be translated FIRST just to find out it would be discarded. kpszsu
// (Ukrainian Air Force) alone was 127 posts/48h for an 8-post (6.3%) keep
// rate — not because it's low-value, but because it's a live air-defense
// tracking channel: most posts are "a drone is currently heading toward
// X" (correctly dropped, no incident yet), only some confirm an actual
// impact ("Strike UAV on Kharkiv") or explicit threat.
//
// These patterns are deliberately generous, not precise — false POSITIVES
// here just mean a translation gets spent the same as it would have been
// spent anyway (no regression from today); false NEGATIVES mean a real
// incident silently never gets translated at all, which is the actual
// risk worth guarding against without native fluency in any of these four
// languages. So: match on common word stems/roots liberally (covering
// likely conjugated forms via substring matching, not exact word
// boundaries) rather than trying to be linguistically precise, and when
// in doubt, include the term. This is a cheap FIRST gate only — anything
// that matches still goes through the same real English-language
// classification after translation, unchanged; this only decides whether
// translation is worth attempting at all.
//
// Kept deliberately narrow to genuine incident/strike/casualty/threat
// vocabulary (mirroring CONFLICT_ACTION_PATTERN/DIRECT_THREAT_PATTERN's
// own scope exactly) — NOT bare weapon-type words like "drone" or
// "missile" alone, which appear in both kept AND dropped kpszsu posts
// equally (a drone merely existing/transiting isn't the signal; a drone
// STRIKING something is). A pre-filter built on weapon-presence alone
// would fail to filter kpszsu's actual noise pattern.
const FOREIGN_INCIDENT_PATTERNS: Record<string, RegExp> = {
  // Ukrainian (kpszsu, GeneralStaffZSU, DIUkraine, Joint_Forces_Task_Force,
  // V_Zelenskiy_official, dsns_telegram). удар/ударний = strike/strike-type
  // (the specific qualifier kpszsu uses for a confirmed-attack drone/
  // missile vs. a merely-transiting one) — this single root is the main
  // signal that actually separates kpszsu's kept from dropped posts.
  // Verified live 2026-09-10 against kpszsu's real public channel: "удар"
  // correctly matches confirmed-strike posts ("Ударний БпЛА на Харків")
  // and correctly does NOT match in-transit tracking posts ("Реактивний
  // БпЛА..."). влучання/уражен added afterward as extra recall margin
  // specifically for this channel — additional plausible impact/hit
  // synonyms beyond the one root already verified, since a channel this
  // valued is worth erring further toward over-matching.
  //
  // 2026-09-10, second pass: "пуск" (launch/launched) added — a real
  // recall gap a translated-sample review surfaced: kpszsu posts guided-
  // bomb LAUNCH notifications ("Пуски керованих авіаційних бомб ворожою
  // тактичною авіацією на Харківщину") that were being silently pre-
  // filter-dropped in Ukrainian, never even attempted for translation —
  // despite CONFLICT_ACTION_PATTERN in telegram.ts explicitly recognizing
  // "missile (launch|fired)" as valid incident language for the exact same
  // kind of report once translated. "приліт" (arrival/impact) was
  // considered for removal in the same pass as a likely source of wasted
  // translations on pure in-transit tracking posts, but that's an
  // inference, not verified against the actual original text (only the
  // English output is retained once a post is translated) — kept in place
  // rather than cut on a guess, consistent with this pattern's own stated
  // bias (false positives over false negatives).
  //
  // 2026-09-10, third pass: "над містом" (over the city) added — kpszsu's
  // distinct "[city] / Jet UAV over the city! Stay in cover!" alert (24
  // all-time occurrences sampled), a different signal from ordinary
  // in-transit tracking: the object is directly over a NAMED city right
  // now, not just approaching from a distance. See
  // IMMEDIATE_CITY_THREAT_PATTERN in src/lib/sources/telegram.ts for the
  // matching English-side change that actually lets this survive the real
  // kept decision once translated — this pre-filter addition alone only
  // gets it as far as translation being attempted.
  uk: /удар|атак|вбит|загинул|загибл|поранен|збит|перехоплен|приліт|пуск|влучан|влучив|уражен|вибух|обстріл|пошкодж|зруйнован|жертв|загроз|попередж|над містом/i,
  // Russian (mod_russia, rybar, wargonzo, medvedev_telegram).
  ru: /удар|атак|убит|погиб|ранен|сбит|перехват|взрыв|обстрел|поврежд|разрушен|жертв|угроз|предупрежд/i,
  // Farsi (iribnews, farsna, defapress_ir, sepah_pasdaran,
  // TasnimNewsAgency, mehrnews, Nournews_ir).
  fa: /حمله|کشته|زخمی|انفجار|بمباران|سرنگون|قربانی|تهدید|هشدار|ضربه|حمل?ات/i,
  // Arabic (army21ye). Lowest volume of the four — Arabic's root-and-
  // pattern morphology means substring matching catches less of the real
  // conjugation space than for the other three, but partial coverage
  // still beats none for a single low-volume channel.
  ar: /هجوم|قتل|جرحى|إصاب|انفجار|قصف|إسقاط|ضحاي|تهديد|تحذير|ضرب/i,
};

// Returns true (translate it) for any language this module doesn't have a
// pattern for — fail toward translating, not toward silently dropping an
// entire language's coverage because a pattern is missing.
export function hasLikelyForeignIncidentLanguage(text: string, language: string): boolean {
  const pattern = FOREIGN_INCIDENT_PATTERNS[language];
  if (!pattern) return true;
  return pattern.test(text);
}
