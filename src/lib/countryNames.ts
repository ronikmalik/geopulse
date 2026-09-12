// Best-effort country-name -> ISO 3166-1 alpha-2 resolver for free-text
// location strings from feeds that don't supply a country code directly
// (USGS "place" strings, NASA EONET titles). Not exhaustive geocoding —
// just enough to attribute events to a country for the risk panel.
// Exported (in addition to resolveCountryFromText below) for
// src/lib/classificationArchive.ts's vocabulary-candidate report — country
// names, demonyms, capital cities, and heads-of-state are exactly the kind
// of high-frequency noise that would otherwise crowd out genuine incident
// verbs in a raw word-frequency count, and this is already the curated,
// maintained list of exactly those terms rather than a second one that
// could drift out of sync with it.
export const COUNTRY_NAME_TO_ALPHA2: Record<string, string> = {
  afghanistan: "AF",
  albania: "AL",
  algeria: "DZ",
  argentina: "AR",
  armenia: "AM",
  australia: "AU",
  austria: "AT",
  azerbaijan: "AZ",
  bahamas: "BS",
  bahrain: "BH",
  bangladesh: "BD",
  belarus: "BY",
  belgium: "BE",
  belize: "BZ",
  bolivia: "BO",
  "bosnia and herzegovina": "BA",
  botswana: "BW",
  brazil: "BR",
  bulgaria: "BG",
  burundi: "BI",
  cambodia: "KH",
  cameroon: "CM",
  canada: "CA",
  chad: "TD",
  chile: "CL",
  china: "CN",
  colombia: "CO",
  "costa rica": "CR",
  croatia: "HR",
  cuba: "CU",
  cyprus: "CY",
  czechia: "CZ",
  "czech republic": "CZ",
  "democratic republic of the congo": "CD",
  "dr congo": "CD",
  denmark: "DK",
  djibouti: "DJ",
  "dominican republic": "DO",
  ecuador: "EC",
  egypt: "EG",
  "el salvador": "SV",
  eritrea: "ER",
  estonia: "EE",
  eswatini: "SZ",
  ethiopia: "ET",
  fiji: "FJ",
  finland: "FI",
  france: "FR",
  gabon: "GA",
  georgia: "GE",
  germany: "DE",
  ghana: "GH",
  greece: "GR",
  greenland: "GL",
  guatemala: "GT",
  guinea: "GN",
  haiti: "HT",
  honduras: "HN",
  hungary: "HU",
  iceland: "IS",
  india: "IN",
  indonesia: "ID",
  iran: "IR",
  iraq: "IQ",
  ireland: "IE",
  israel: "IL",
  italy: "IT",
  jamaica: "JM",
  japan: "JP",
  jordan: "JO",
  kazakhstan: "KZ",
  kenya: "KE",
  kosovo: "XK",
  kuwait: "KW",
  kyrgyzstan: "KG",
  laos: "LA",
  latvia: "LV",
  lebanon: "LB",
  lesotho: "LS",
  liberia: "LR",
  libya: "LY",
  lithuania: "LT",
  luxembourg: "LU",
  madagascar: "MG",
  malawi: "MW",
  malaysia: "MY",
  maldives: "MV",
  mali: "ML",
  malta: "MT",
  mauritania: "MR",
  mauritius: "MU",
  mexico: "MX",
  moldova: "MD",
  mongolia: "MN",
  montenegro: "ME",
  morocco: "MA",
  mozambique: "MZ",
  myanmar: "MM",
  burma: "MM",
  namibia: "NA",
  nepal: "NP",
  netherlands: "NL",
  "new zealand": "NZ",
  nicaragua: "NI",
  niger: "NE",
  nigeria: "NG",
  "north korea": "KP",
  "north macedonia": "MK",
  norway: "NO",
  oman: "OM",
  pakistan: "PK",
  panama: "PA",
  "papua new guinea": "PG",
  paraguay: "PY",
  peru: "PE",
  philippines: "PH",
  poland: "PL",
  portugal: "PT",
  qatar: "QA",
  romania: "RO",
  russia: "RU",
  rwanda: "RW",
  "saudi arabia": "SA",
  senegal: "SN",
  serbia: "RS",
  "sierra leone": "SL",
  singapore: "SG",
  slovakia: "SK",
  slovenia: "SI",
  somalia: "SO",
  "south africa": "ZA",
  "south korea": "KR",
  "south sudan": "SS",
  spain: "ES",
  "sri lanka": "LK",
  sudan: "SD",
  suriname: "SR",
  sweden: "SE",
  switzerland: "CH",
  syria: "SY",
  taiwan: "TW",
  tajikistan: "TJ",
  tanzania: "TZ",
  thailand: "TH",
  togo: "TG",
  "trinidad and tobago": "TT",
  tunisia: "TN",
  turkey: "TR",
  turkiye: "TR",
  turkmenistan: "TM",
  uganda: "UG",
  ukraine: "UA",
  "united arab emirates": "AE",
  "united kingdom": "GB",
  "united states": "US",
  "u.s.": "US",
  uruguay: "UY",
  uzbekistan: "UZ",
  vanuatu: "VU",
  venezuela: "VE",
  vietnam: "VN",
  yemen: "YE",
  zambia: "ZM",
  zimbabwe: "ZW",
  "puerto rico": "PR",
  "new caledonia": "NC",
  tonga: "TO",
  "solomon islands": "SB",
  "ivory coast": "CI",
  "cote d'ivoire": "CI",
  "republic of the congo": "CG",
  "cabo verde": "CV",
  "cape verde": "CV",

  // Demonyms/nationality adjectives — news headlines usually name the actor
  // this way ("Dutch central bank...", "Ukrainian officials...") rather
  // than the country noun itself. Ambiguous ones (e.g. bare "korean") are
  // deliberately omitted rather than guessing.
  dutch: "NL",
  british: "GB",
  russian: "RU",
  ukrainian: "UA",
  iranian: "IR",
  israeli: "IL",
  palestinian: "PS",
  chinese: "CN",
  taiwanese: "TW",
  american: "US",
  french: "FR",
  german: "DE",
  japanese: "JP",
  "south korean": "KR",
  "north korean": "KP",
  indian: "IN",
  pakistani: "PK",
  turkish: "TR",
  saudi: "SA",
  egyptian: "EG",
  syrian: "SY",
  iraqi: "IQ",
  lebanese: "LB",
  yemeni: "YE",
  afghan: "AF",
  emirati: "AE",
  qatari: "QA",
  polish: "PL",
  italian: "IT",
  spanish: "ES",
  brazilian: "BR",
  mexican: "MX",
  canadian: "CA",
  australian: "AU",
  indonesian: "ID",
  vietnamese: "VN",
  filipino: "PH",
  thai: "TH",
  nigerian: "NG",
  ethiopian: "ET",
  sudanese: "SD",
  somali: "SO",
  venezuelan: "VE",

  // Major conflict/politics-relevant cities — an article naming a city but
  // never the country by name (very common: "Kyiv", "Tehran", "Gaza")
  // otherwise fails to resolve at all.
  kyiv: "UA",
  kiev: "UA",
  moscow: "RU",
  tehran: "IR",
  "tel aviv": "IL",
  jerusalem: "IL",
  gaza: "PS",
  ramallah: "PS",
  beijing: "CN",
  taipei: "TW",
  pyongyang: "KP",
  seoul: "KR",
  damascus: "SY",
  baghdad: "IQ",
  kabul: "AF",
  islamabad: "PK",
  "new delhi": "IN",
  tokyo: "JP",
  london: "GB",
  washington: "US",
  paris: "FR",
  berlin: "DE",
  brussels: "BE",
  ankara: "TR",
  istanbul: "TR",
  riyadh: "SA",
  cairo: "EG",
  beirut: "LB",
  sanaa: "YE",
  khartoum: "SD",
  mogadishu: "SO",
  caracas: "VE",
  // Added 2026-09-09 alongside Burkina Faso's country-level entry above —
  // real, current Sahel/JNIM conflict relevance justifies a capital-city
  // fallback the other 31 newly-added countries in this pass don't have.
  ouagadougou: "BF",

  // Heads of state/government for countries this app tracks closely — a
  // headline naming the leader ("Putin warns NATO...") but not the country
  // or a demonym is common and otherwise resolves to nothing. Full
  // names/surnames only, never a bare first name or short token, so
  // there's no risk of matching as a substring inside an unrelated word
  // (see resolveCountryFromText below, which does a plain substring
  // search). This list drifts out of date as leadership changes — it's a
  // bonus signal, not load-bearing, since the demonym/country/city
  // matches above already cover the common case.
  "xi jinping": "CN",
  putin: "RU",
  zelensky: "UA",
  zelenskyy: "UA",
  netanyahu: "IL",
  "kim jong un": "KP",
  khamenei: "IR",
  pezeshkian: "IR",
  erdogan: "TR",
  "mohammed bin salman": "SA",

  // Named armed groups/cartels — added 2026-09-05 alongside classify.ts's
  // REGIONAL_ACTORS keyword expansion, for the exact same reason cities/
  // leaders are here: a story naming the group ("Boko Haram kills a dozen
  // in northeastern Nigeria") often never uses the plain country name at
  // all, so without this it clears the topical gate and severity check
  // but still fails to resolve a country and gets dropped anyway. Only
  // safe, low-collision, mostly-single-country group names are here —
  // multi-country groups (JNIM/ISWAP span the Sahel/Lake Chad region with
  // no one right answer) and bare short acronyms that collide with an
  // unrelated common meaning (RSF/Reporters Without Borders, ADF/
  // Australia's Defence Force) are deliberately left out, resolved
  // instead by whatever actual country name the article names directly.
  "boko haram": "NG",
  iswap: "NG",
  "al-shabaab": "SO",
  "al shabaab": "SO",
  "al-shabab": "SO",
  tplf: "ET",
  m23: "CD",
  "allied democratic forces": "CD",
  codeco: "CD",
  seleka: "CF",
  "anti-balaka": "CF",
  "rapid support forces": "SD",
  houthi: "YE",
  houthis: "YE",
  "ansar allah": "YE",
  "hayat tahrir al-sham": "SY",
  taliban: "AF",
  "isis-k": "AF",
  "khorasan province": "AF",
  "tehrik-i-taliban": "PK",
  "pakistani taliban": "PK",
  naxalite: "IN",
  naxals: "IN",
  "lashkar-e-taiba": "IN",
  "jaish-e-mohammed": "IN",
  pkk: "TR",
  "abu sayyaf": "PH",
  "new people's army": "PH",
  "arakan army": "MM",
  "sendero luminoso": "PE",
  farc: "CO",
  "clan del golfo": "CO",
  "sinaloa cartel": "MX",
  "jalisco new generation": "MX",

  // Iran's "Axis of Resistance" network + adjacent Middle East gaps —
  // added 2026-09-05 after a direct question about whether this coverage
  // existed. Hezbollah/Hamas/Houthis were already handled (flashpoint
  // vocabulary above); these are the pieces that weren't: IRGC/Quds Force
  // is Iran's own military actor abroad, not a "country name" in the
  // usual sense, but a headline naming it often doesn't say "Iran" at
  // all. The Iraqi Shia militias (Kata'ib Hezbollah, Asa'ib Ahl al-Haq,
  // Harakat Hezbollah al-Nujaba) and the umbrella name they jointly claim
  // attacks under ("Islamic Resistance in Iraq") resolve to Iraq, the
  // country where they operate — not Iran, which funds/arms them but
  // isn't where the story's event happens.
  irgc: "IR",
  "quds force": "IR",
  "islamic jihad": "PS",
  "kata'ib hezbollah": "IQ",
  "kataib hezbollah": "IQ",
  "asa'ib ahl al-haq": "IQ",
  "asaib ahl al-haq": "IQ",
  "al-nujaba": "IQ",
  "islamic resistance in iraq": "IQ",
  "syrian democratic forces": "SY",
  "isis-sinai": "EG",
  "sinai province": "EG",

  // 2026-09-09: mechanical cross-check (full-country-coverage audit) found
  // these named actors already gated classify.ts's topical KEYWORDS net
  // (REGIONAL_ACTORS/IRAN_PROXY_ACTORS) but had zero country mapping here —
  // an article naming one, with nothing else resolvable, silently failed
  // country resolution despite clearing every other gate.
  //
  // JNIM (Jama'at Nasr al-Islam wal Muslimin) is the Sahel's largest active
  // al-Qaeda-linked insurgency, spanning Mali/Burkina Faso/Niger — mapped
  // to its founding country/primary base, the same "pick the single most-
  // associated country" precedent already used above for iswap->NG despite
  // ISWAP also spanning Chad/Niger/Cameroon.
  jnim: "ML",
  // MS-13 and Barrio 18 are two of the most-covered Central American gang
  // stories in English-language wire coverage, especially El Salvador's
  // Bukele-era mass-incarceration crackdown — both originated among
  // Salvadoran communities and are most consistently tied to El Salvador
  // specifically in real reporting.
  "ms-13": "SV",
  "barrio 18": "SV",
  // Bare phrase alongside the existing irgc/quds force entries above — a
  // headline can say "Iran's Revolutionary Guard" without ever saying
  // "IRGC".
  "revolutionary guard": "IR",

  // 32 sovereign states/entities with zero prior entry here — see the
  // matching 2026-09-09 addition to countryCentroids.ts for the full
  // audit rationale (these had no centroid either, so were unconditionally
  // dropped regardless of what any source reported). Demonyms added only
  // where genuinely safe/unambiguous, matching this file's existing
  // collision-avoidance caution; a few entries below carry an inline note
  // where a real (if narrow) collision risk exists and was weighed
  // deliberately rather than missed.
  andorra: "AD",
  andorran: "AD",
  angola: "AO",
  angolan: "AO",
  "antigua and barbuda": "AG",
  antiguan: "AG",
  barbados: "BB",
  barbadian: "BB",
  // "Benin City" (Nigeria) is a real, known collision this left-boundary
  // match doesn't disambiguate — accepted the same way this file already
  // accepts "kenya" matching inside "Kenyan" as a structural tradeoff of
  // the matching strategy, not something worth a bespoke carve-out for one
  // city name.
  benin: "BJ",
  beninese: "BJ",
  bhutan: "BT",
  bhutanese: "BT",
  brunei: "BN",
  "burkina faso": "BF",
  burkinabe: "BF",
  comoros: "KM",
  comorian: "KM",
  // "Dominica" is a left-bounded prefix of "Dominican"/"Dominicana" — a
  // bare demonym mention of Dominican Republic nationality (no country
  // name in the same sentence) would misresolve here. Accepted: neither
  // country currently has a "dominican" demonym entry at all (so this
  // isn't a regression for any full "Dominican Republic" mention — that
  // already resolves correctly via the longer, same-start-index phrase
  // below, which wins per resolveCountryFromText's own dedup rule), and
  // Dominica's real-world news footprint is negligible next to Dominican
  // Republic's.
  dominica: "DM",
  "equatorial guinea": "GQ",
  gambia: "GM",
  gambian: "GM",
  grenada: "GD",
  grenadian: "GD",
  // Hyphenated form matches real AP/Reuters style ("Guinea-Bissau"); a
  // rarer unhyphenated "Guinea Bissau" would instead match bare "guinea"
  // (Guinea, GN) above — a known, low-probability residual gap given how
  // consistently wire style hyphenates this one.
  "guinea-bissau": "GW",
  guyana: "GY",
  guyanese: "GY",
  kiribati: "KI",
  liechtenstein: "LI",
  "marshall islands": "MH",
  micronesia: "FM",
  monaco: "MC",
  nauru: "NR",
  palau: "PW",
  // Real wire style overwhelmingly uses "St." over "Saint" for these three
  // — both forms mapped since the matcher does no punctuation
  // normalization (lowercases only), so "St. Kitts" and "Saint Kitts"
  // require separate literal keys to both resolve.
  "saint kitts and nevis": "KN",
  "st. kitts and nevis": "KN",
  "st kitts and nevis": "KN",
  "st. kitts": "KN",
  "st kitts": "KN",
  "saint lucia": "LC",
  "st. lucia": "LC",
  "st lucia": "LC",
  "saint vincent and the grenadines": "VC",
  "st. vincent and the grenadines": "VC",
  "st vincent and the grenadines": "VC",
  samoa: "WS",
  samoan: "WS",
  "san marino": "SM",
  "sao tome and principe": "ST",
  seychelles: "SC",
  seychellois: "SC",
  // "East Timor" is at least as common as "Timor-Leste" in English-
  // language wire coverage — both mapped.
  "timor-leste": "TL",
  "east timor": "TL",
  tuvalu: "TV",
  "vatican city": "VA",
  vatican: "VA",
  "holy see": "VA",
};

const NAMES_BY_LENGTH_DESC = Object.keys(COUNTRY_NAME_TO_ALPHA2).sort(
  (a, b) => b.length - a.length,
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// User report (2026-09-08): "oman keeps getting news not related to
// oman." Root cause — the plain `lower.indexOf(name)` substring scan this
// file used to use has no concept of a word boundary, so "oman" (as a
// bare 4-letter substring) matched inside "woman"/"women's", "Ottoman",
// "Roman"/"Romania"/"Romanian" — all extremely common in ordinary news
// text — silently misattributing any story containing them to Oman.
//
// Fix is a LEFT word-boundary only, not `\bname\b` on both sides: a
// right-side boundary would also block the many countries here that rely
// on their base name matching as a PREFIX of an unlisted demonym form —
// "kenya" inside "Kenyan," "nepal" inside "Nepali," etc. — which several
// dozen entries in this map depend on since they were never given an
// explicit demonym pair the way iraq/iraqi, syria/syrian, turkey/turkish
// above were. A left boundary alone still blocks every real case found
// ("w"+oman, "Ott"+oman, "R"+oman+ia — the country name is never preceded
// by a word character in the actual country name) while leaving that
// suffix-matching behavior completely intact ("Kenya" + "n" still matches
// "kenya" as a left-bounded prefix). Precompiled once, not per call —
// this runs on every classified item.
const NAME_REGEX_BY_NAME = new Map<string, RegExp>(
  NAMES_BY_LENGTH_DESC.map((name) => [name, new RegExp(`\\b${escapeRegExp(name)}`)]),
);

// Real live bug (2026-09-12): "AI agents being tested by OpenAI involved in
// cyber-attack on another service, say researchers" — an article with zero
// connection to Mali — got attributed to Mali (ML) because its snippet said
// "malicious packages," and the left-boundary-only match above (see the
// 2026-09-08 comment) has no concept of a RIGHT boundary at all, so "mali"
// matches the first four letters of "malicious" same as it matches the bare
// word "Mali". Same class of bug also confirmed live for "malice",
// "malign", "malignant", and "chador" (-> Chad). A right boundary can't
// just be `\b` unconditionally, though — that would break the exact
// prefix-demonym matching ("kenya" in "Kenyan", "nepal" in "Nepali") the
// left-boundary-only design was deliberately built to keep (per the
// 2026-09-08 comment above). This restores a right boundary while still
// allowing a small, common set of demonym-forming continuations.
const DEMONYM_SUFFIX_RE = /^(?:ians?|ese|ish|is|ans?|ns?|i)\b/;

function hasCleanRightBoundary(text: string, endIndex: number): boolean {
  const rest = text.slice(endIndex);
  if (!/^[a-z]/.test(rest)) return true; // already at a real boundary (space, punctuation, end of string)
  return DEMONYM_SUFFIX_RE.test(rest);
}

// Case-sensitive institutional signals, matched against the ORIGINAL text
// (not lowercased) and folded into the same earliest-position candidate
// pool as country names in resolveCountryFromText below — never returned
// unconditionally. Two things live here for the same reason: they're too
// short/collision-prone to be safe as plain lowercase substrings, but
// unambiguous once case is respected.
//
// "US" is the big one — deliberately excluded from the general map because
// the pronoun "us" ("tells us", "let us know") would match constantly
// case-insensitively. But English convention writes the country in full
// caps specifically to disambiguate from the pronoun (which, even in
// title-cased headlines, only ever gets its first letter capitalized: "Us"
// not "US") — so a case-sensitive \bUS\b is safe. The agency acronyms
// (all federal, all unambiguous once case-sensitive) exist because a huge
// share of US-relevant stories — ICE enforcement actions, DHS/FBI/CIA
// operations — never spell out "United States" at all.
//
// Guarded by requiring at least one lowercase letter elsewhere in the
// text: an all-caps wire-style headline ("TELLS US WHAT HAPPENED") would
// make "US" indistinguishable from the pronoun again, so this whole check
// is skipped for shouty all-caps text rather than risk a false positive.
//
// UK/USA/UAE live here for the identical reason "US" does, found via a
// 2026-09-04 full-database recompute audit: as bare lowercase substring
// keys they matched inside unrelated words with no relation to any of
// these countries — "uk" inside "Levuka" and "Dukono", "usa" inside "Nusa
// Tenggara" — silently misattributing earthquakes/eruptions on those
// islands to the UK or US. Case-sensitive whole-word matching against the
// original text fixes it the same way it already worked for "US".
const INSTITUTION_ACRONYM_TO_ALPHA2: [RegExp, string][] = [
  [/\bU\.S\.?\b/, "US"],
  [/\bUS\b/, "US"],
  [/\bUSA\b/, "US"],
  [/\bICE\b/, "US"],
  [/\bDHS\b/, "US"],
  [/\bFBI\b/, "US"],
  [/\bCIA\b/, "US"],
  [/\bPentagon\b/, "US"],
  [/\bWhite House\b/, "US"],
  [/\bUK\b/, "GB"],
  [/\bUAE\b/, "AE"],
  [/\bDowning Street\b/, "GB"],
  [/\bKremlin\b/, "RU"],
];

// A demonym directly modifying a person noun ("Venezuelan man",
// "Iranian national", "Chinese student") describes that PERSON's
// nationality — it is not a signal about where the event happened. Without
// this, "Venezuelan man shot by ICE in the US" would resolve to Venezuela
// just because "Venezuelan" is the first recognized token, even though the
// story is a US law-enforcement event.
const PERSON_NOUNS = new Set([
  "man", "woman", "boy", "girl", "teen", "teenager", "teens", "child",
  "children", "kid", "migrant", "migrants", "immigrant", "immigrants",
  "national", "nationals", "citizen", "citizens", "driver", "worker",
  "workers", "student", "students", "tourist", "tourists", "refugee",
  "refugees", "couple", "family", "suspect", "gunman", "soldier",
  "soldiers", "officer", "diplomat", "businessman", "businesswoman",
  "detainee", "detainees", "asylum-seeker", "national's",
]);

function wordAfter(lowerText: string, index: number): string {
  const m = lowerText.slice(index).match(/^[\s,'-]*([a-z]+)/);
  return m ? m[1] : "";
}

// A country appearing as the object of a targeting preposition — sanctions
// ON a country, tariffs AGAINST it, capital moving AWAY FROM it — is who
// the story's risk is actually about, even when a different country is the
// grammatical actor named earlier in the sentence ("Norway moves pension
// fund money away from the US" is a US risk, not a Norway one: Norway is
// just who's doing the moving). Checked before the general earliest-match
// scan, which would otherwise pick the actor purely because it's mentioned
// first.
const TARGETING_PATTERNS: RegExp[] = [
  /\b(?:pulls?|pulling|pulled|withdraws?|withdrawing|withdrew|moves?|moving|moved|shifts?|shifting|shifted|divests?|divesting|divested|sells?|selling|sold|dumps?|dumping|dumped)\b[^.]{0,60}\b(?:money|funds?|assets?|investments?|holdings?|capital|reserves|stakes?)\b[^.]{0,40}\b(?:away from|out of|from)\s+(?:the\s+)?([a-zA-Z][a-zA-Z .]{2,40}?)(?=[\s,.]|$)/i,
  /\b(?:sanctions?|tariffs?|embargo(?:es)?|export controls?|trade restrictions?|travel ban)\b[^.]{0,25}\b(?:on|against)\s+(?:the\s+)?([a-zA-Z][a-zA-Z .]{2,40}?)(?=[\s,.]|$)/i,
];

function resolveNameInPhrase(phrase: string): string | null {
  const lower = phrase.toLowerCase();
  for (const name of NAMES_BY_LENGTH_DESC) {
    const m = NAME_REGEX_BY_NAME.get(name)!.exec(lower);
    if (m && hasCleanRightBoundary(lower, m.index + name.length)) return COUNTRY_NAME_TO_ALPHA2[name];
  }
  return null;
}

// A country's own forces/personnel/facilities being the OBJECT of an attack
// verb ("Iran hits US military targets") is a real signal the story is
// about that country's risk exposure — same idea as TARGETING_PATTERNS
// above, generalized from sanctions/capital-flight to attacks. Kept
// separate (rather than folded into TARGETING_PATTERNS) because it needs
// case-sensitive "US" matching, not resolveNameInPhrase's lowercase name
// map — a plainly-spelled target country ("strikes on Israeli forces") is
// already handled fine by the general earliest-mention scan below.
const ATTACK_ON_US_PATTERN =
  /\b(?:hits?|hit|strikes?|struck|targets?|targeted|attacks?|attacked|kills?|killed|wounds?|wounded|bombs?|bombed|shells?|shelled)\b[^.]{0,25}\b(?:U\.S\.?|US)\b[^.]{0,20}\b(?:military|naval|air(?:craft)?|troops?|forces?|base|bases|embassy|embassies|consulate|personnel|warship|soldiers?|servicemembers?|sailors?|marines?|targets?)\b/;

// Generalizes ATTACK_ON_US_PATTERN's own idea — "who the attack verb's
// object is" beats "who's grammatically named first" — from the US
// specifically to any recognized country/city/demonym. Found via the
// 2026-09-08 Gemini classifier-audit's country_mismatch findings: four
// independent real headlines all resolved to the ACTOR (mentioned first,
// per the earliest-mention design below) instead of who the attack
// actually endangers — "Iran continues attacks on Kurdish opposition
// group in northern Iraq" (should be IQ, resolved IR), "Russian drone
// damages ... newsroom in Kyiv" (should be UA, resolved RU), "Israeli
// escalation in south Lebanon leaves 27 dead" (should be LB, resolved
// IL), "Houthi strikes set fire to Saudi oil sites" (should be SA,
// resolved YE) — all four in the very same audit run.
//
// Deliberately narrow: only fires when an attack/escalation word is
// actually found AND a real country/city name resolves somewhere after
// it — falls through to the normal earliest-mention scan otherwise, so
// this can only improve cases it's confident about, never regress the
// general "actor named first" rule this file documents below (which is
// still correct for non-attack sentences — "Dutch bank moves gold from
// UK to Canada" stays a Netherlands story).
const ATTACK_CONTEXT_PATTERN =
  /\b(?:strikes?|struck|hits?|hit|attacks?|attacked|bombs?|bombed|bombing|shells?|shelled|shelling|raids?|raided|damages?|damaged|airstrikes?|escalat\w*)\b/i;

// How far past the attack word to look for the target's name — generous
// enough for "attacks on Kurdish opposition group in northern Iraq" (the
// real country name can be several words after the verb) without being
// so wide it picks up an unrelated country mentioned in a trailing,
// disconnected clause.
const ATTACK_TARGET_WINDOW_CHARS = 200;

function resolveAttackTarget(text: string): string | null {
  const lower = text.toLowerCase();
  const m = ATTACK_CONTEXT_PATTERN.exec(lower);
  if (!m) return null;
  const after = lower.slice(m.index + m[0].length, m.index + m[0].length + ATTACK_TARGET_WINDOW_CHARS);
  return resolveNameInPhrase(after);
}

// Picks whichever recognized name appears EARLIEST in the text, not the
// longest one — a headline's subject/actor is almost always named first
// ("Dutch bank moves gold from UK to Canada" is a Netherlands story, not a
// UK or Canada one just because those names are longer or happen to match
// too). Length only breaks a tie between two names starting at the exact
// same position, which is when one is a genuine substring/qualifier of the
// other (e.g. "south korea" containing "korea") — the pre-sorted, longer
// name wins that comparison so the more specific match takes it.
//
// TARGETING_PATTERNS runs first, unconditionally: the actor named first
// genuinely isn't who the risk is about, so that one's a real override.
// INSTITUTION_ACRONYM_TO_ALPHA2 is NOT a similar override — it exists only
// because short tokens like "US" need case-sensitive handling the general
// lowercase scan can't do safely, not because an institution mention should
// beat an earlier, more central country name. ("Russian drone strikes
// Ukraine security HQ as US talks on the war are expected" is a
// Russia/Ukraine story; "US" is a bystander mentioned last, not the
// subject.) So institution matches are folded into the same earliest-
// position candidate pool as country names, rather than checked first and
// returned immediately. PERSON_NOUNS (a demonym describing a person isn't
// a location) is applied inline in that same pool.
export function resolveCountryFromText(text: string): string | null {
  for (const pattern of TARGETING_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      const resolved = resolveNameInPhrase(m[1]);
      if (resolved) return resolved;
    }
  }

  if (/[a-z]/.test(text) && ATTACK_ON_US_PATTERN.test(text)) return "US";

  const attackTarget = resolveAttackTarget(text);
  if (attackTarget) return attackTarget;

  const lower = text.toLowerCase();
  const candidates: { index: number; length: number; alpha2: string }[] = [];

  if (/[a-z]/.test(text)) {
    for (const [pattern, alpha2] of INSTITUTION_ACRONYM_TO_ALPHA2) {
      const m = text.match(pattern);
      if (m && m.index !== undefined) {
        candidates.push({ index: m.index, length: m[0].length, alpha2 });
      }
    }
  }

  for (const name of NAMES_BY_LENGTH_DESC) {
    const m = NAME_REGEX_BY_NAME.get(name)!.exec(lower);
    if (m && hasCleanRightBoundary(lower, m.index + name.length)) {
      candidates.push({ index: m.index, length: name.length, alpha2: COUNTRY_NAME_TO_ALPHA2[name] });
    }
  }

  // Collapse same-start-index matches to just the longest (e.g. "venezuela"
  // is a substring of "venezuelan" at the same index) — otherwise a
  // person-noun skip on the longer match falls through to a truncated
  // remnant of the very same word, which no longer lands on a real word
  // boundary and defeats the skip.
  candidates.sort((a, b) => a.index - b.index || b.length - a.length);
  const deduped: typeof candidates = [];
  for (const c of candidates) {
    if (deduped.length && deduped[deduped.length - 1].index === c.index) continue;
    deduped.push(c);
  }

  for (const c of deduped) {
    if (PERSON_NOUNS.has(wordAfter(lower, c.index + c.length))) continue;
    return c.alpha2;
  }
  return null;
}
