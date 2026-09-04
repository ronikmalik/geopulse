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
  uae: "AE",
  "united kingdom": "GB",
  uk: "GB",
  "united states": "US",
  usa: "US",
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
};

const NAMES_BY_LENGTH_DESC = Object.keys(COUNTRY_NAME_TO_ALPHA2).sort(
  (a, b) => b.length - a.length,
);

// Case-sensitive institutional signals, checked against the ORIGINAL text
// before the general lowercase scan runs. Two things live here for the
// same reason: they're too short/collision-prone to be safe as plain
// lowercase substrings, but unambiguous once case is respected.
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
const INSTITUTION_ACRONYM_TO_ALPHA2: [RegExp, string][] = [
  [/\bU\.S\.?\b/, "US"],
  [/\bUS\b/, "US"],
  [/\bICE\b/, "US"],
  [/\bDHS\b/, "US"],
  [/\bFBI\b/, "US"],
  [/\bCIA\b/, "US"],
  [/\bPentagon\b/, "US"],
  [/\bWhite House\b/, "US"],
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
    if (lower.includes(name)) return COUNTRY_NAME_TO_ALPHA2[name];
  }
  return null;
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
// Three checks run first, each because "earliest mention" gets the wrong
// answer in a specific, common way: TARGETING_PATTERNS (the actor named
// first isn't who the risk is about), INSTITUTION_ACRONYM_TO_ALPHA2 (short
// tokens the general scan can't safely handle case-insensitively), and —
// inline in the scan below — PERSON_NOUNS (a demonym describing a person
// isn't a location).
export function resolveCountryFromText(text: string): string | null {
  for (const pattern of TARGETING_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      const resolved = resolveNameInPhrase(m[1]);
      if (resolved) return resolved;
    }
  }

  if (/[a-z]/.test(text)) {
    for (const [pattern, alpha2] of INSTITUTION_ACRONYM_TO_ALPHA2) {
      if (pattern.test(text)) return alpha2;
    }
  }

  const lower = text.toLowerCase();
  const candidates = NAMES_BY_LENGTH_DESC
    .map((name) => ({ name, index: lower.indexOf(name) }))
    .filter((c) => c.index !== -1)
    .sort((a, b) => a.index - b.index || b.name.length - a.name.length);

  for (const c of candidates) {
    if (PERSON_NOUNS.has(wordAfter(lower, c.index + c.name.length))) continue;
    return COUNTRY_NAME_TO_ALPHA2[c.name];
  }
  return null;
}
