export const CATEGORIES = [
  "us-iran",
  "russia-ukraine",
  "israel-palestine",
  "china-taiwan",
  "north-korea",
  "political-instability",
  "humanitarian",
  "earthquake",
  "natural-disaster",
  "climate-hazard",
  "infrastructure-outage",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  "us-iran": "US – Iran",
  "russia-ukraine": "Russia – Ukraine",
  "israel-palestine": "Israel – Palestine",
  "china-taiwan": "China – Taiwan",
  "north-korea": "North Korea",
  "political-instability": "Political Instability",
  humanitarian: "Humanitarian Crisis",
  earthquake: "Earthquakes",
  "natural-disaster": "Natural Hazards",
  "climate-hazard": "Climate Hazards",
  "infrastructure-outage": "Infrastructure Outages",
  other: "Other",
};

// Categories driven by a GDELT text-search query. Feed-driven categories
// (earthquake, natural-disaster, climate-hazard, infrastructure-outage)
// arrive pre-classified with their own source module and don't need a
// query here.
export const NEWS_CATEGORIES = [
  "us-iran",
  "russia-ukraine",
  "israel-palestine",
  "china-taiwan",
  "north-korea",
  "political-instability",
  "humanitarian",
] as const;

export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

export const CATEGORY_QUERIES: Record<NewsCategory, string> = {
  "us-iran": "Iran AND (US OR United States OR sanctions OR strike OR nuclear)",
  "russia-ukraine": "Russia AND Ukraine AND (strike OR missile OR troops OR front)",
  "israel-palestine": "Israel AND (Gaza OR Palestine OR Hamas OR Hezbollah OR Lebanon)",
  "china-taiwan": "China AND Taiwan AND (military OR incursion OR strait)",
  "north-korea": "North Korea AND (missile OR nuclear OR Kim Jong)",
  "political-instability":
    '(coup OR "military takeover" OR "state of emergency" OR "martial law") OR (protests AND (crackdown OR banned)) OR (election AND (fraud OR annulled OR postponed OR disputed)) OR (government AND (collapse OR resign OR ousted OR overthrown))',
  humanitarian:
    '(famine OR "food insecurity" OR malnutrition) OR (refugees OR "internally displaced" OR displacement) OR ("humanitarian crisis" OR "humanitarian emergency") OR (disease AND (outbreak OR epidemic))',
};

// User question (2026-09-09): "why am i not getting news on india, pakistan,
// south asia generally, the -stans in central asia, west africa, etc.?" Root
// cause investigated live: the 5 named-flashpoint queries above obviously
// don't cover these regions, and the two generic catch-alls
// (political-instability/humanitarian) are the ONLY GDELT queries that
// could — but their own keyword nets (coup/martial-law/election-fraud,
// famine/refugee/disease-outbreak) never match a Kashmir border clash or a
// Central Asian protest crackdown unless it happens to also use that exact
// vocabulary. Worse, runIngest's ROTATION_CHUNK_SIZE=1 means those two
// queries — the app's only GDELT path into these regions at all — only run
// once every ~7 rotation cycles (~105 min), not every cycle.
//
// Fix has two parts, both requiring MORE query slots than cron-job.org's
// hard 30s per-request timeout allows the main rotation to spend (see
// runIngest's own comment on ROTATION_CHUNK_SIZE) — so this whole set runs
// through a SEPARATE, dedicated path (see runIngest's priorityGdelt option
// and .github/workflows/ingest-priority.yml) triggered directly by GitHub
// Actions, which has no such timeout:
//   1. Re-run political-instability/humanitarian far more often (every
//      ~15 min instead of ~105) — same query text, just not rotation-
//      starved anymore.
//   2. Two genuinely NEW queries targeting the specific gap: named
//      insurgent/separatist actors and border-tension vocabulary for South
//      Asia and Central Asia that no existing query searches for at all.
//      Not folded into political-instability's own query text above —
//      that string is already ~238 characters, and a live test
//      (2026-09-09) found GDELT's real query-length ceiling sits somewhere
//      between 238 and 263 chars, leaving almost no headroom.
// West Africa isn't a third query here — it's already reasonably covered
// by RSS (premium-times-nigeria/allafrica/africanews/african-arguments,
// see sources/rss.ts) in a way India/Pakistan and Central Asia structurally
// aren't: docs/SOURCE_CREDIBILITY.md's 2026-09-08 gap-filling pass found
// every Pakistani outlet candidate fails on documented censorship pressure
// and Central Asia has essentially zero free-press RSS presence at all
// (Eurasianet, the one high-credibility specialist, is Cloudflare-blocked)
// — a confirmed dead end re-checked the day before this fix, not an
// unexamined gap.
// ALWAYS run every priorityGdelt cycle — the two broad catch-alls, kept
// maximally fresh since they're this app's most general-purpose reach into
// any country outside the 5 named flashpoints.
export const PRIORITY_GDELT_ALWAYS: { category: NewsCategory; query: string }[] = [
  { category: "political-instability", query: CATEGORY_QUERIES["political-instability"] },
  { category: "humanitarian", query: CATEGORY_QUERIES["humanitarian"] },
];

// 2026-09-10 (user request: "build dedicated queries for all 200+
// countries... keep building more and more"): this list is designed to
// grow indefinitely without needing any other code change — see
// PRIORITY_GDELT_ROTATION_CHUNK_SIZE in ingest.ts, which rotates through
// this list in chunks each cycle (the same rotation-not-run-everything
// idiom the main /api/ingest route already uses for its 5 named
// flashpoints) rather than running the whole list every time — GDELT
// rate limits and GitHub Actions' 6-minute job timeout both cap how many
// queries can run in one cycle, so this scales by rotating through more
// entries over a longer full-cycle time, not by running more per cycle.
// Each entry should be a real, researched query for a specific country or
// tight regional cluster's actual current conflict/instability/
// humanitarian-crisis vocabulary (named actors, specific disputes) — not
// a generic term already covered by PRIORITY_GDELT_ALWAYS above.
export const PRIORITY_GDELT_ROTATION: { category: NewsCategory; query: string }[] = [
  {
    category: "political-instability",
    // Afghanistan (bare "Taliban"/"ISIS-K"/"Khorasan Province", already
    // mapped to AF in countryNames.ts) had no GDELT reach at all before
    // this: docs/SOURCE_CREDIBILITY.md explicitly names "Pakistan and
    // Afghanistan... South Asia's actual terrorism theater" as a real,
    // still-open gap.
    query:
      '"Tehrik-i-Taliban" OR "Lashkar-e-Taiba" OR "Jaish-e-Mohammed" OR Naxalite OR Kashmir OR "Line of Control" OR (India AND Pakistan AND border) OR (Afghanistan AND Taliban) OR Baluchistan',
  },
  {
    category: "political-instability",
    query:
      "(Kazakhstan OR Uzbekistan OR Kyrgyzstan OR Tajikistan OR Turkmenistan) AND (unrest OR protest OR clash OR border OR crackdown OR coup)",
  },
  // Bangladesh/Nepal/Sri Lanka is docs/SOURCE_CREDIBILITY.md's own named
  // remaining gap ("no dedicated outlet clears the bar... simply unrated
  // by any tracker") — zero GDELT reach and no RSS/regional-umbrella
  // coverage before this.
  {
    category: "political-instability",
    query:
      '(Bangladesh OR Nepal OR "Sri Lanka") AND (protest OR unrest OR crackdown OR coup OR "state of emergency" OR clash OR strike)',
  },
  // Guyana was one of 32 countries with literally zero coverage
  // capability (see countryCentroids.ts/countryNames.ts) — added for a
  // real, current story: the Guyana-Venezuela Essequibo territorial
  // dispute, not just completeness.
  {
    category: "political-instability",
    query: "Guyana AND Venezuela AND (Essequibo OR border OR territorial OR troops)",
  },
  // countryNames.ts already maps several real, active Latin American
  // armed actors (FARC, Sendero Luminoso, Sinaloa/Jalisco cartels, MS-13,
  // Barrio 18) — enough that this app already treats cartel/gang conflict
  // as a tracked signal — but no GDELT query searched for this
  // vocabulary before this.
  {
    category: "political-instability",
    query:
      '"cartel violence" OR "gang violence" OR "Sendero Luminoso" OR FARC OR (Haiti AND gang) OR (Mexico AND cartel) OR (Ecuador AND (gang OR cartel))',
  },

  // 2026-09-10: 64 queries added in one pass, covering the remaining
  // countries not already reached by a named flashpoint, a dedicated RSS
  // outlet, or the entries above — user request: "build dedicated queries
  // for all 200+ countries... do ur own web deep dive to understand the
  // issues in each individual countries." Researched via 5 parallel web
  // research passes (one per world region), each required to find REAL,
  // currently-verifiable evidence (named actors, specific ongoing crises,
  // dated events) rather than inventing generic "instability" claims —
  // countries with no verifiable current signal were deliberately left
  // out rather than padded with a placeholder query. All verified
  // programmatically before shipping: every string under 200 characters
  // (longest 111), balanced parens/quotes. See each region's own comment
  // for the specific sourcing.

  // --- Latin America & Caribbean ---
  // Nicaragua: Ortega/Murillo "co-presidency," ~1,150+ political
  // prisoners, mass statelessness stripping (HRW World Report 2026).
  { category: "political-instability", query: 'Nicaragua AND (Ortega OR Murillo) AND (repression OR "political prisoners" OR crackdown OR exile)' },
  // Honduras/Guatemala: MS-13/Barrio 18 territorial control driving
  // displacement and migration (UNRIC/GOV.UK country notes, 2026).
  { category: "humanitarian", query: '(Honduras OR Guatemala) AND (MS-13 OR "Barrio 18" OR gang) AND (violence OR extortion OR displaced)' },
  // Guatemala: Attorney General Consuelo Porras/judiciary waging what
  // Arevalo calls an "attempted coup"; 13 impeachment petitions since
  // inauguration (UPI/HRW/Latin America Reports).
  { category: "political-instability", query: 'Guatemala AND Arevalo AND (coup OR prosecutor OR impeachment OR "judicial crisis")' },
  // Jamaica: repeated states of emergency/ZOSOs, PM Holness's "war on
  // gangs."
  { category: "political-instability", query: 'Jamaica AND (gang OR homicide) AND ("state of emergency" OR crackdown OR violence)' },
  // Trinidad and Tobago: nationwide State of Public Emergency declared
  // March 2026, extended repeatedly over mass shootings/gang reprisals.
  { category: "political-instability", query: '"Trinidad and Tobago" AND (gang OR shooting) AND ("state of emergency" OR crackdown)' },
  // Bolivia: President Paz's state of emergency amid 50+ days of
  // blockades, 14+ killed, ministers resigning (Al Jazeera/CNN/NPR).
  { category: "political-instability", query: 'Bolivia AND (Paz OR blockade OR protest) AND (resign OR unrest OR "state of emergency")' },
  // Argentina: Milei labor reform triggered general strikes/clashes,
  // falling approval (~35%).
  { category: "political-instability", query: 'Argentina AND Milei AND (protest OR strike OR unrest OR austerity)' },
  // Brazil: PCC/Comando Vermelho now US/Paraguay-designated terrorist
  // orgs; Rio raids, sharply rising violent deaths in disputed zones.
  { category: "political-instability", query: 'Brazil AND (PCC OR "Comando Vermelho" OR favela) AND (raid OR shootout OR "gang violence")' },
  // Cuba: full grid collapse (11M without power), fuel/food shortages,
  // rare protests, a torched party office.
  { category: "humanitarian", query: 'Cuba AND (blackout OR shortage OR protest) AND (unrest OR crackdown OR crisis)' },
  // Dominican Republic/Haiti: mass deportations (200K+ in 2025, 70% YoY
  // increase), raids on bateyes, UN condemnation.
  { category: "humanitarian", query: '"Dominican Republic" AND Haiti AND (deportation OR migrant OR bateyes OR border)' },
  // Paraguay: PCC/Comando Vermelho use it as a logistics base; joint
  // Brazil-Paraguay Operation Basalto/Agate.
  { category: "political-instability", query: 'Paraguay AND (PCC OR "Comando Vermelho" OR "tri-border") AND (trafficking OR smuggling)' },
  // Panama: Cobre Panama copper mine restart talks reviving the 2023-style
  // protest coalition.
  { category: "political-instability", query: 'Panama AND (mine OR "Cobre Panama" OR canal) AND (protest OR unrest OR blockade)' },
  // Costa Rica: record homicide levels, transformed into a cartel
  // logistics hub, new extradition/sicariato laws.
  { category: "humanitarian", query: '"Costa Rica" AND (cartel OR narco OR trafficking) AND (homicide OR violence OR sicariato)' },

  // --- Asia-Pacific & Pacific Islands ---
  // Thailand-Cambodia: 2025 border war under a fragile Dec 2025 ceasefire
  // both sides accuse each other of violating.
  { category: "political-instability", query: '(Thailand AND Cambodia AND (border OR clash OR ceasefire OR troops)) OR "Preah Vihear"' },
  // Thailand's southern insurgency: BRN militants staged 51 coordinated
  // arson/bombing attacks across Pattani/Yala/Narathiwat (Aug 2026).
  { category: "political-instability", query: '(Pattani OR Yala OR Narathiwat) AND (attack OR bombing OR BRN OR insurgent OR ambush)' },
  // Cambodia: Hun Manet government running mass arrests of Candlelight/
  // opposition figures on treason charges (88 political prisoners).
  { category: "political-instability", query: 'Cambodia AND (opposition OR "Candlelight Party" OR "Kem Sokha" OR treason OR crackdown)' },
  // PNG: Highlands/Enga tribal warfare with modern weapons killed 49+ in a
  // single Feb 2026 incident.
  { category: "political-instability", query: '("Papua New Guinea" OR Enga OR Highlands) AND (tribal OR clan OR violence OR massacre)' },
  // Bougainville: PNG parliament's Aug 30 2026 vote on the 2019
  // independence referendum was delayed with no procedure agreed.
  { category: "political-instability", query: 'Bougainville AND (independence OR referendum OR secession OR Marape OR parliament)' },
  // Solomon Islands: PM Manele ousted by no-confidence vote, replaced by
  // Matthew Wale (May 2026); ongoing China/Taiwan-linked factional rivalry.
  { category: "political-instability", query: '"Solomon Islands" AND (Wale OR Manele OR "no confidence" OR unrest OR Honiara)' },
  // Vanuatu: Napat government survived a no-confidence motion amid an
  // unresolved citizenship-by-investment scandal.
  { category: "political-instability", query: 'Vanuatu AND (Napat OR "no confidence" OR parliament OR coalition OR unrest)' },
  // Fiji: coup-legacy tensions active ahead of 2026 elections; Bainimarama
  // convicted (Oct 2026) over a 2021 police dismissal case.
  { category: "political-instability", query: 'Fiji AND (Rabuka OR Bainimarama OR coup OR "political crisis" OR election)' },
  // Tonga: cabinet collapsing under electoral bribery convictions, no
  // stable governing majority post-2025 election.
  { category: "political-instability", query: 'Tonga AND (bribery OR cabinet OR "no confidence" OR corruption OR government)' },
  // Laos: public debt >100% of GDP, dependent on ad hoc Chinese deferrals
  // to avoid default.
  { category: "humanitarian", query: 'Laos AND (debt OR default OR currency OR kip OR "economic crisis" OR restructuring)' },
  // Pacific Islands Forum: Sept 2026 Palau summit saw 5 of 18 leaders
  // absent, China "furious" over Taiwan's presence.
  { category: "political-instability", query: '"Pacific Islands Forum" AND (China OR Taiwan OR boycott OR tension OR rivalry)' },
  // Maldives: accelerating "democratic decay" (judiciary/media control)
  // amid continued China-India strategic rivalry.
  { category: "political-instability", query: 'Maldives AND (China OR India OR judiciary OR crackdown OR opposition OR Muizzu)' },

  // --- Europe / Balkans / Caucasus ---
  // Bosnia: Dodik ousted from the RS presidency; real near-term flashpoint
  // risk around the Oct 4 2026 RS general election.
  { category: "political-instability", query: '(Bosnia OR "Republika Srpska" OR Dodik) AND (secession OR crackdown OR unrest OR crisis OR "Dayton accord")' },
  // Kosovo/Serbia: northern Kosovo remains volatile — police raids on Serb
  // institutions, legacy of the 2023 Banjska attack.
  { category: "political-instability", query: '(Kosovo OR Serbia) AND ("northern Kosovo" OR Banjska OR Mitrovica) AND (clash OR unrest OR protest OR raid)' },
  // Georgia: 18+ months of protests against Georgian Dream/Ivanishvili;
  // five opposition leaders charged with "coup" attempt (Oct 2025).
  { category: "political-instability", query: '(Georgia OR Tbilisi OR "Georgian Dream" OR Ivanishvili) AND (protest OR crackdown OR arrest OR coup)' },
  // Armenia: Pashinyan's party won the June 2026 election amid Russian
  // interference allegations and a church-state conflict.
  { category: "political-instability", query: '(Armenia OR Pashinyan OR Yerevan) AND (protest OR arrest OR crackdown OR opposition OR election)' },
  // Azerbaijan: Aliyev crackdown escalating — journalists/activists
  // convicted July 2026 (12-15 year sentences), expanding transnational
  // repression.
  { category: "political-instability", query: '(Azerbaijan OR Aliyev OR Baku) AND (journalist OR crackdown OR arrest OR repression OR sentenced)' },
  // Belarus: Lukashenko released some political prisoners but ~1,150+
  // remain jailed.
  { category: "political-instability", query: '(Belarus OR Lukashenko OR Minsk) AND (crackdown OR "political prisoner" OR opposition OR arrest)' },
  // Belarus: still weaponizing migrants at the Poland/Lithuania/Latvia
  // border (Lithuania filed a UN complaint).
  { category: "humanitarian", query: '(Belarus OR Lukashenko) AND (Poland OR Lithuania OR Latvia) AND (migrant OR border OR crisis OR smuggling)' },
  // Moldova: Transnistria tension over Russia opening unauthorized Duma
  // polling stations (Sept 2026); Sandu warns of an engineered crisis.
  { category: "political-instability", query: '(Moldova OR Transnistria OR Chisinau) AND (Russia OR sabotage OR crisis OR unrest OR interference)' },
  // Baltic Sea: confirmed ongoing undersea cable sabotage (Helsinki-
  // Tallinn, Lithuania-Latvia), "shadow fleet" vessels boarded.
  { category: "political-instability", query: '("Baltic Sea" OR Estonia OR Finland OR Lithuania OR Latvia) AND (cable OR sabotage OR "shadow fleet" OR anchor)' },
  // Poland/Romania: confirmed Russian missile/drone airspace incursions
  // (a Russian missile hit a Polish village, 8 dead, July 2026).
  { category: "political-instability", query: '(Poland OR Romania) AND (Russia OR drone OR missile) AND (airspace OR incursion OR violation OR NATO)' },
  // Serbia: Vucic announced resignation (June 2026) after 18 months of
  // student-led protests; snap elections underway.
  { category: "political-instability", query: '(Serbia OR Vucic OR Belgrade) AND (protest OR resign OR election OR unrest OR crisis)' },
  // Bulgaria: new populist-nationalist government after the prior one
  // collapsed under mass protests (Dec 2025) over the budget.
  { category: "political-instability", query: '(Bulgaria OR Sofia OR Radev) AND (protest OR crisis OR unrest OR nationalist OR "pro-Russia")' },
  // Romania: caretaker government since a May 2026 no-confidence collapse;
  // far-right AUR polling ~36%.
  { category: "political-instability", query: '(Romania OR Bucharest OR AUR) AND (crisis OR deadlock OR protest OR "far-right" OR government)' },

  // --- Middle East / North Africa (beyond existing flashpoint coverage) ---
  // Libya: GNU (Tripoli) vs. LNA/Haftar (east) deadlocked over election
  // legislation; militia buildups, sporadic clashes below full-war
  // threshold.
  { category: "political-instability", query: '(Libya OR Tripoli OR Haftar OR GNU) AND (militia OR clash OR shelling OR mobilization OR ceasefire)' },
  // Tunisia: Kais Saied's crackdown escalating — journalists arrested,
  // dozens sentenced in a "Conspiracy Case," continued protests.
  { category: "political-instability", query: '(Tunisia OR "Kais Saied" OR Tunis) AND (crackdown OR arrest OR protest OR opposition OR sentenced)' },
  // Morocco/Algeria: momentum toward Morocco's autonomy plan (UNSC Res
  // 2797) sharply rejected by Algeria/Polisario.
  { category: "political-instability", query: '(Morocco OR Algeria OR Polisario OR "Western Sahara") AND (tension OR clash OR dispute OR militia OR ceasefire)' },
  // Egypt: Israel suspended gas exports indefinitely post-Iran-war shock,
  // Suez toll revenue down, protest count surged, digital crackdowns.
  { category: "humanitarian", query: '(Egypt OR Cairo OR Suez) AND ("economic crisis" OR austerity OR protest OR strike OR shortage)' },
  // Bahrain: unprecedented Shia crackdown since May 2026 — 600+ arrested/
  // summoned, 50+ clerics detained, tied to Iran-war spillover.
  { category: "humanitarian", query: '(Bahrain) AND (Shia OR crackdown OR arrest OR cleric OR sectarian OR "citizenship revoked")' },
  // Kuwait: Emir's 2024 parliament dissolution/constitutional suspension
  // still unresolved into 2026, ~42,000 stripped of citizenship.
  { category: "political-instability", query: '(Kuwait) AND (emir OR parliament OR "constitutional crisis" OR "citizenship revoked" OR dissolved)' },
  // Saudi Arabia: Houthi missiles/drones hit Aramco facilities in Jizan/
  // Najran/Abha (Sept 8 2026), 73 wounded, refinery halted — targets
  // Saudi Arabia itself, distinct from existing Yemen/Houthi coverage.
  { category: "humanitarian", query: '(Jizan OR Najran OR Abha OR Aramco OR "Saudi Arabia") AND (Houthi OR missile OR drone OR wounded OR refinery)' },
  // UAE/Saudi: Iran-linked drones launched from Iraq hit Saudi Arabia and
  // struck the Barakah nuclear plant in the UAE (May 2026), intercepted.
  { category: "political-instability", query: '(UAE OR "Saudi Arabia" OR Barakah) AND ("drone attack" OR intercepted OR militia OR Iraq)' },
  // Oman: Iranian drone strikes hit Omani ports since March 2026 despite
  // Oman's neutrality — real spillover distinct from Iran's own coverage.
  { category: "political-instability", query: '(Oman OR Duqm OR Salalah OR Sohar) AND (drone OR strike OR attack OR Iran OR port)' },

  // --- Sub-Saharan Africa ---
  // Mali/Burkina Faso/Niger: JNIM ran a nationwide fuel blockade in Mali
  // (Sept 2026), attacked Bamako/killed Mali's defense minister (Apr
  // 2026), hit Niamey's international airport (June 2026, 30+ killed).
  { category: "political-instability", query: '(Mali OR "Burkina Faso" OR Niger) AND (JNIM OR jihadist OR militant OR ambush OR blockade OR attack)' },
  // Niger: junta (Tiani) survived a mutinous coup attempt in Aug 2026;
  // military loyalty is fragile.
  { category: "political-instability", query: 'Niger AND (Tiani OR junta OR mutiny OR Niamey OR coup OR ECOWAS)' },
  // Guinea-Bissau: Nov 2025 election triggered a military coup days before
  // results; a Dec 2026 election is now scheduled under junta oversight.
  { category: "political-instability", query: '"Guinea-Bissau" AND (coup OR junta OR Embalo OR election OR military)' },
  // Cameroon: Anglophone/Ambazonian separatist conflict plus Lake Chad
  // Basin Boko Haram spillover in the Far North.
  { category: "political-instability", query: 'Cameroon AND (Anglophone OR Ambazonia OR separatist OR "Boko Haram" OR "Far North")' },
  // Chad: opposition leader Succes Masra imprisoned (20 years), GCAP
  // opposition coalition dissolved by the Supreme Court (2026).
  { category: "political-instability", query: 'Chad AND (Deby OR opposition OR crackdown OR Masra OR GCAP OR arrest)' },
  // Chad/CAR: 900,000+ Sudanese refugees and RSF cross-border attacks
  // straining the region.
  { category: "humanitarian", query: '(Chad OR "Central African Republic") AND (refugees OR displaced OR Sudanese OR humanitarian)' },
  // Mozambique: ISIS-Mozambique intensified IED/mortar attacks in Cabo
  // Delgado through mid-2026; Rwanda threatening troop withdrawal.
  { category: "political-instability", query: 'Mozambique AND ("Cabo Delgado" OR "Islamic State" OR insurgent OR IED OR ambush)' },
  // Rwanda: M23 fighting resumed in South Kivu (Walungu/Mwenga/Fizi) in
  // 2026 despite a Doha peace roadmap; Rwandan troops remain embedded.
  { category: "political-instability", query: 'Rwanda AND (M23 OR Congo OR Goma OR Kivu OR Bukavu OR offensive)' },
  // Tanzania: Oct-Nov 2025 post-election violence (opposition claims
  // 1,000-2,000 killed) with unresolved tensions.
  { category: "political-instability", query: 'Tanzania AND (Chadema OR protest OR crackdown OR unrest OR "election violence")' },
  // Kenya: Gen Z protest movement reignited by the 2026 Finance Bill,
  // echoing 2024-25 unrest.
  { category: "political-instability", query: 'Kenya AND (protest OR "Gen Z" OR "Finance Bill" OR crackdown OR unrest OR Ruto)' },
  // Uganda: Jan 2026 disputed election win for Museveni; army chief
  // publicly threatened Bobi Wine; ongoing NUP crackdown/abductions.
  { category: "political-instability", query: 'Uganda AND (Museveni OR "Bobi Wine" OR NUP OR crackdown OR abduction OR opposition)' },
  // Zimbabwe: CAB3 constitutional amendment extending Mnangagwa's term to
  // 2030 has split ZANU-PF.
  { category: "political-instability", query: 'Zimbabwe AND (Mnangagwa OR "ZANU-PF" OR constitution OR succession OR crackdown)' },
  // Eswatini: state repression (Public Order Act, Sedition Act) persists;
  // 67% now favor multiparty democracy per polling.
  { category: "political-instability", query: 'Eswatini AND (protest OR crackdown OR democracy OR activist OR Mswati OR arrest)' },
  // Madagascar: Oct 2025 CAPSAT-led coup ousted Rajoelina; continued
  // instability into 2026.
  { category: "political-instability", query: 'Madagascar AND (CAPSAT OR transition OR coup OR protest OR military OR unrest)' },
  // South Africa: Operation Dudula-driven xenophobic violence killed
  // Mozambican nationals (Mossel Bay, May 2026); mass repatriations.
  { category: "political-instability", query: '"South Africa" AND (xenophobic OR Dudula OR migrants OR "foreign nationals" OR violence)' },
  // Senegal: President Faye fired PM Sonko (May 2026), formed a rival
  // party, formalizing a ruling-coalition split amid debt crisis.
  { category: "political-instability", query: 'Senegal AND (Sonko OR Faye OR crisis OR parliament OR party OR debt)' },
  // Zambia: Aug 2026 election marred by a suspended vote count, fraud
  // accusations, court closures, opposition arrests.
  { category: "political-instability", query: 'Zambia AND (Hichilema OR election OR Mundubile OR fraud OR dispute OR arrest)' },

  // --- Western Europe (added after explicitly checking whether "stable
  // democracy" was masking real instability rather than assuming it —
  // most of Western Europe genuinely doesn't need a dedicated query
  // given how much RSS/global-wire coverage it already gets, but these
  // specific countries had real, current, verifiable crises the generic
  // coverage could plausibly still miss under a non-"political-
  // instability"-tagged headline) ---
  // France: chronic, current crisis — Bayrou ousted Sept 2025, Lecornu
  // resigned and was reappointed within days (Oct 2025), 5th PM in ~2
  // years, ongoing budget standoff.
  { category: "political-instability", query: '(France OR Macron OR Lecornu) AND ("no confidence" OR censure OR "govt collapse" OR "budget crisis")' },
  // Germany: AfD landslide in Saxony-Anhalt (43.8%, Sept 6 2026); CDU
  // insiders calling it the party's "deepest crisis" in 81 years.
  { category: "political-instability", query: '(Germany OR Merz OR AfD) AND (coalition OR crisis OR "no confidence" OR collapse OR chancellor)' },
  // UK: Starmer resigned, Andy Burnham became PM (July 2026); pro-
  // independence parties simultaneously control Scotland/Wales/NI's
  // devolved governments; SNP floating a unilateral referendum.
  { category: "political-instability", query: '(UK OR Britain OR Scotland OR Burnham OR SNP) AND ("independence referendum" OR "constitutional crisis" OR unrest)' },
  // Greenland/Denmark: very much live — EU pledged $232M to Greenland
  // (Sept 8 2026) specifically to counter ongoing Trump annexation
  // threats; 2026 already included military posturing and the largest
  // protests in Greenland's history.
  { category: "political-instability", query: '(Greenland OR Denmark) AND (Trump OR annex OR annexation OR sovereignty OR protest OR military)' },
  // Spain: Sanchez in what analysts call his "deepest crisis yet" —
  // stacking corruption scandals; parliament passed a non-binding
  // resolution urging his resignation (177-171).
  { category: "political-instability", query: '(Spain OR Sanchez) AND (corruption OR scandal OR "no confidence" OR resign OR crisis)' },
  // Slovakia: sustained 2024-2026 protest movement against Fico's pro-
  // Russia/anti-Ukraine stance, continuing into 2026 with Fico himself
  // warning of confrontation moving "onto the streets."
  { category: "political-instability", query: '(Slovakia OR Fico) AND (protest OR unrest OR crisis OR "pro-Russia" OR resign)' },
  // Hungary: Fidesz/Orban reportedly lost the 2026 election to Magyar's
  // Tisza after a "deepening rule of law crisis" per EU Parliament —
  // genuinely unusual, not routine democratic politics. Based on a
  // slightly older search pass than the others in this batch (research
  // agent's web-search quota was exhausted before a final confirmation
  // pass) — worth a spot-check if this query's real-world relevance ever
  // looks off, but the underlying signal (a major election upset with
  // rule-of-law tension) is solid enough to include now.
  { category: "political-instability", query: '(Hungary OR Orban OR Magyar OR Tisza) AND (election OR transition OR "constitutional crisis" OR unrest)' },
];

// Kept for any external reference to the old combined shape — always
// ALWAYS-queries first, matching the priority order they used to run in.
export const PRIORITY_GDELT_QUERIES: { category: NewsCategory; query: string }[] = [
  ...PRIORITY_GDELT_ALWAYS,
  ...PRIORITY_GDELT_ROTATION,
];

// CORE categories are on by default and shown as the always-visible top-bar
// pills — this is the original GeoPulse view (the five hand-picked
// flashpoints). LAYER categories are extra signal types that stay off by
// default and are opted into from the Data Layers dashboard, so the main
// view doesn't get cluttered as more sources/pillars are added over time.
export const CORE_NEWS_CATEGORIES = [
  "us-iran",
  "russia-ukraine",
  "israel-palestine",
  "china-taiwan",
  "north-korea",
] as const;

export const CORE_CATEGORIES = [...CORE_NEWS_CATEGORIES, "other"] as const;

export const LAYER_CATEGORIES = [
  "political-instability",
  "humanitarian",
  "earthquake",
  "natural-disaster",
  "climate-hazard",
  "infrastructure-outage",
] as const;
