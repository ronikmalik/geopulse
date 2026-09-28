import type { Category } from "../categories";

// The channel list on its own, with no imports beyond a type (2026-09-28).
// sourceLabels.ts needs the labels in the browser; importing them from
// telegram.ts pulled that module's translate/classify/archive chain into
// the client bundle, database driver included. telegram.ts re-exports both.

export interface TelegramChannelConfig {
  handle: string;
  label: string; // shown to the reader, e.g. "Rybar (pro-Russian military channel)"
  country: string; // ISO 3166-1 alpha-2
  category: Category;
  language: string; // ISO 639-1 source language, or "en" to skip translation
}

// See docs/TELEGRAM_SOURCES.md for how this list was built (sourced from
// ISW's own published citations, not guessed) and the reasoning for what
// was deliberately left out. The 2026-09-04 v2 pass (multi-report,
// multi-theater audit, not just one day) added the block below the divider
// comment — same bar as v1: unambiguous institutional identity, cited
// repeatedly by ISW/CTP, not a personal/analyst/milblogger account (those
// stay in TELEGRAM_SOURCES.md's "Tier 2 candidates" pending individual
// credibility reads, per the discipline already established for v1).
export const TELEGRAM_CHANNELS: TelegramChannelConfig[] = [
  { handle: "GeneralStaffZSU", label: "Ukraine General Staff (official)", country: "UA", category: "russia-ukraine", language: "uk" },
  { handle: "kpszsu", label: "Ukrainian Air Force (official)", country: "UA", category: "russia-ukraine", language: "uk" },
  { handle: "mod_russia", label: "Russian Ministry of Defense (official)", country: "RU", category: "russia-ukraine", language: "ru" },
  // category corrected 2026-09-11 (user report) from "natural-disaster" to
  // "russia-ukraine" — DSNS's real posting content is overwhelmingly
  // Russian-strike/shelling-caused fires and casualties ("Russian drone
  // strike on an ambulance," "enemy UAV hitting a five-story administrative
  // building"), not natural-cause incidents (earthquake, wildfire, flood —
  // the direct/structural sources FIRMS/EONET/GDACS already cover those).
  // Every channel here gets a single fixed category (see the DirectItem
  // builder below — no per-post keyword classification), so a wrong pick
  // here mislabels 100% of the channel's output, not just edge cases.
  { handle: "dsns_telegram", label: "Ukraine State Emergency Service (official)", country: "UA", category: "russia-ukraine", language: "uk" },
  { handle: "rybar", label: "Rybar (pro-Russian military channel, unverified)", country: "RU", category: "russia-ukraine", language: "ru" },
  { handle: "wargonzo", label: "WarGonzo (pro-Russian military channel, unverified)", country: "RU", category: "russia-ukraine", language: "ru" },
  { handle: "presstv", label: "Press TV (Iran state media)", country: "IR", category: "us-iran", language: "en" },
  // --- v2 additions (2026-09-04), see docs/TELEGRAM_SOURCES.md "v2" section ---
  { handle: "DIUkraine", label: "Ukrainian Defense Intelligence (official)", country: "UA", category: "russia-ukraine", language: "uk" },
  { handle: "Joint_Forces_Task_Force", label: "Ukrainian Joint Forces (official military)", country: "UA", category: "russia-ukraine", language: "uk" },
  { handle: "V_Zelenskiy_official", label: "Volodymyr Zelensky (official)", country: "UA", category: "russia-ukraine", language: "uk" },
  { handle: "medvedev_telegram", label: "Dmitry Medvedev - Deputy Chair, Russian Security Council (official)", country: "RU", category: "russia-ukraine", language: "ru" },
  // defapress_ir, sepah_pasdaran, TasnimNewsAgency, mehrnews, Nournews_ir
  // removed (2026-09-10, user request) — the five worst-yielding Farsi
  // channels by real all-time data: TasnimNewsAgency 0/20 kept (0%, ever),
  // sepah_pasdaran 5/155 (3.2%), mehrnews 7/307 (2.3%), Nournews_ir 8/392
  // (2.1%), defapress_ir 4/100 (4%) — together 44% of the current
  // translation-pending backlog (180/409) and ~42% of all-time translated-
  // candidate volume, for a combined ~2.7% keep rate.
  //
  // iribnews and farsna removed in a follow-up pass, same day — real
  // content comparison against presstv found direct duplication, not just
  // topical overlap: iribnews and farsna repeated each other's wire text
  // near-verbatim in multiple cases (both mirror Al-Mayadeen — Arabic-
  // language, not English, so this wasn't presstv's own content leaking
  // in), and presstv (English, zero translation cost) independently
  // covered several of the same real events (the Sirik/Kuhestak wedding
  // strike, Gaza/Lebanon strikes) that iribnews/farsna spent real
  // translation budget to also surface.
  { handle: "army21ye", label: "Houthi Armed Forces spokesperson (official, unverified claims)", country: "YE", category: "us-iran", language: "ar" },
];
