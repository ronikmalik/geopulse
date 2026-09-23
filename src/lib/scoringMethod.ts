// What a country's score counts, and how (2026-09-23).
//
// Until this module the risk engine summed one number per ARTICLE. Two
// measurements taken against live data on 2026-09-23 showed what that
// was really measuring:
//
//   1. Media echo. 1,094 of the 5,231 events scored in the 30-day window
//      (21%) were cross-outlet duplicates of a story already counted —
//      rows eventDedup.ts had already identified and hidden from the feed,
//      but which risk.ts still added up in full. For Saudi Arabia it was
//      194 of 289 (67%). A story five outlets carried scored five times.
//
//   2. Sensor volume. Brazil read "Extreme" on the strength of 189 NASA
//      FIRMS thermal-anomaly clusters and essentially nothing else;
//      Indonesia, Australia and Angola likewise. A satellite's detection
//      count scales with land area and fire season, not with human
//      consequence, and it was being summed as if every detection were a
//      separate crisis.
//
// Both are corrected here, in the same spirit as exposure.ts: each rule
// is narrow, each constant is written down with the reason for its value,
// and the whole methodology carries a version number so no chart or model
// ever compares a number computed one way with a number computed another.

// Bumped whenever a change alters what the published score means. Stored
// on every country_state_history snapshot and every risk prediction, so a
// score series can always be split at its methodology boundaries and the
// forecasting model never learns "the score dropped 30% on 2026-09-23" as
// if it were something that happened in the world.
//   1 — severity x time decay (original)
//   2 — + population exposure for hazards (2026-09-22, exposure.ts)
//   3 — stories not articles, corroboration, sensor saturation, and
//       recalibrated Pulse Level thresholds (this file, 2026-09-23)
export const SCORING_VERSION = 3;

// When version 2 went live — the deploy of commit 33dabf4. Used once, by
// the migration that backfills the version onto snapshots written before
// the column existed.
export const SCORING_V2_LIVE_AT = "2026-09-22T20:49:38Z";

// ---------------------------------------------------------------------
// Corroboration: independent confirmation is signal, repetition is not.
//
// Dropping duplicates outright would throw away something real — a story
// that four independent outlets confirmed is more likely to be real and
// significant than one only a single outlet carried. So the lead story of
// a duplicate cluster keeps a bounded bonus for the number of DISTINCT
// sources that also carried it. Distinct sources, not articles: GDELT is
// a single source here however many domains it spans, so an aggregator
// echoing itself earns nothing — the same rule the alert engine applies.
//
// Logarithmic because the second confirmation says more than the tenth:
// 1 extra source -> x1.2, 3 -> x1.4, 7 or more -> x1.6 (the cap). The cap
// keeps a story that saturates the news cycle from outweighing several
// separate incidents, which is exactly the article-counting bias this
// replaces.
export const CORROBORATION_STEP = 0.2;
export const CORROBORATION_MAX = 1.6;

export function corroborationMultiplier(independentSources: number): number {
  if (!Number.isFinite(independentSources) || independentSources <= 0) return 1;
  return Math.min(CORROBORATION_MAX, 1 + CORROBORATION_STEP * Math.log2(1 + independentSources));
}

export function corroborationMultiplierSqlExpr(countSql: string): string {
  return `least(${CORROBORATION_MAX}, 1 + ${CORROBORATION_STEP} * log(2, (1 + coalesce(${countSql}, 0))::numeric))`;
}

// ---------------------------------------------------------------------
// Sensor saturation: no single instrument can make a country Extreme.
//
// These feeds emit one row per machine detection. Their volume tracks the
// instrument (orbit coverage, land area, a fire season, a seismically
// busy plate boundary), not the consequence. News is deliberately NOT on
// this list: the number of distinct stories about a country is the thing
// the score is supposed to measure. GDACS is not on it either — its
// alerts are already impact-assessed (green/orange/red) by humans and
// models upstream, one alert per disaster, not per detection.
export const SENSOR_SOURCES: ReadonlySet<string> = new Set(["firms", "usgs", "eonet"]);

// Each sensor's contribution to one country-pillar approaches this value
// and never exceeds it: SENSOR_SATURATION x (1 - e^(-raw / SENSOR_SATURATION)).
// Near-linear for small loads (a handful of detections count almost in
// full), flattening as detections pile up. At 20, and with the hazard
// pillar's 1.3 weight, one saturated sensor reaches ~26 — enough for High
// (see threat.ts's thresholds) but never Extreme. A disaster that really
// is Extreme produces news coverage and GDACS alerts on top of the
// detections, and those are not saturated.
export const SENSOR_SATURATION = 20;

export function isSensorSource(source: string): boolean {
  return SENSOR_SOURCES.has(source);
}

export function saturateSensorWeight(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return SENSOR_SATURATION * (1 - Math.exp(-raw / SENSOR_SATURATION));
}

export function sensorSourceList(): string {
  return [...SENSOR_SOURCES].map((s) => `'${s}'`).join(", ");
}
