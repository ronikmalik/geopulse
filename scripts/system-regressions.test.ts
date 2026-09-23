import assert from "node:assert/strict";
import { test } from "node:test";
import { validKeptAssessments, validDroppedFindings } from "../src/lib/auditValidation";
import { callGeminiJson } from "../src/lib/geminiAuditClient";
import { withCache } from "../src/lib/layerCache";
import { chooseBestK, classifyViaKnn, prepareLabeledExamples } from "../src/lib/textClassifier";
import { isLowCredibility, lookupCredibility } from "../src/lib/sourceCredibility";
import { resolveLocationsBatch } from "../src/lib/geocodeEvents";

const candidates = [{ id: 1, country: "UA", severity: 3, source: "gdelt" }, { id: 2, country: "IR", severity: 3, source: "telegram:presstv" }];
const accepted = { id: 1, country: "UA", severity: 3, validInclusion: true, reasoning: "" };

test("malformed Gemini answers cannot become publication decisions", () => {
  const invalid = [null, 1, "approve", {}, { id: 1 }, { ...accepted, validInclusion: "true" }, { ...accepted, severity: 3.2 }, { ...accepted, severity: 8 }, { ...accepted, country: "null" }, { ...accepted, country: "ZZ" }];
  for (const answer of invalid) assert.deepEqual(validKeptAssessments([answer], candidates), []);
});

test("an omitted reasoning is fine on full agreement but not on a disagreement", () => {
  // Agreement with everything stored: reasoning defaults to "" rather than
  // invalidating the answer (which would just re-spend a Gemini call).
  assert.equal(validKeptAssessments([{ ...accepted, reasoning: undefined }], candidates).length, 1);
  assert.deepEqual(validKeptAssessments([{ ...accepted, reasoning: undefined, severity: 5 }], candidates), []);
  // An unknown/unmodelled code coerces to null (a disagreement with the
  // stored country, so it still needs a reasoning), never to a made-up
  // country the app can't place.
  const [coerced] = validKeptAssessments([{ ...accepted, country: "zz", reasoning: "Territory not modelled" }], candidates);
  assert.equal(coerced.country, null);
  const [lowercased] = validKeptAssessments([{ ...accepted, country: "ua" }], candidates);
  assert.equal(lowercased.country, "UA");
});

test("partial review retains only answered IDs and rejects conflicting duplicate decisions", () => {
  assert.deepEqual(validKeptAssessments([accepted], candidates).map((answer) => answer.id), [1]);
  assert.deepEqual(validKeptAssessments([accepted, { ...accepted, validInclusion: false, reasoning: "Not an incident" }], candidates), []);
  assert.deepEqual(validKeptAssessments([{ ...accepted, id: 999 }], candidates), []);
});

test("review disagreements require an explanation and preserve Press TV country restriction", () => {
  assert.deepEqual(validKeptAssessments([{ ...accepted, validInclusion: false }], candidates), []);
  assert.equal(validKeptAssessments([{ ...accepted, validInclusion: false, reasoning: "Opinion, not a new event" }], candidates).length, 1);
  assert.deepEqual(validKeptAssessments([{ ...accepted, id: 2, country: "US", reasoning: "US assets mentioned" }], candidates), []);
  assert.equal(validKeptAssessments([{ ...accepted, id: 2, country: "IR" }], candidates).length, 1);
});

test("unknown geography uses JSON null and requires an explanation", () => {
  assert.equal(validKeptAssessments([{ ...accepted, country: null, reasoning: "Location unavailable" }], candidates).length, 1);
  assert.deepEqual(validKeptAssessments([{ ...accepted, country: null }], candidates), []);
});

test("false-negative responses distinguish a clean empty audit from an invalid batch", () => {
  const finding = { id: 1, reasoning: "Specific incident", suggestedSeverity: 3, suggestedCountry: "UA" };
  assert.deepEqual(validDroppedFindings([], [1]), []);
  assert.equal(validDroppedFindings([finding], [1])?.length, 1);
  for (const rows of [[null], [finding, finding], [{ ...finding, id: 999 }], [{ ...finding, reasoning: "" }], [{ ...finding, suggestedSeverity: undefined }]]) {
    assert.equal(validDroppedFindings(rows, [1]), null);
  }
});

test("concurrent layer requests share one upstream call", async () => {
  let calls = 0;
  let release!: (value: number) => void;
  const fetcher = () => { calls++; return new Promise<number>((resolve) => { release = resolve; }); };
  const first = withCache("regression:shared", 1000, fetcher);
  const second = withCache("regression:shared", 1000, fetcher);
  await Promise.resolve();
  assert.equal(calls, 1);
  release(42);
  assert.deepEqual(await Promise.all([first, second]), [42, 42]);
  assert.equal(await withCache("regression:shared", 1000, fetcher), 42);
  assert.equal(calls, 1);
});

test("failed cache requests are retriable; unrelated keys remain independent", async () => {
  await assert.rejects(withCache("regression:retry", 1000, () => { throw new Error("upstream unavailable"); }));
  assert.equal(await withCache("regression:retry", 1000, async () => 7), 7);
  assert.deepEqual(await Promise.all([withCache("regression:a", 1000, async () => 1), withCache("regression:b", 1000, async () => 2)]), [1, 2]);
});

test("optimized (k, weighting) selection matches independently evaluated fold predictions", () => {
  const examples = prepareLabeledExamples(Array.from({ length: 63 }, (_, i) => ({ id: i + 1, embedding: [Math.sin(i * 1.7), Math.cos(i * 0.8), 0.5], kept: i % 4 !== 0, category: "other", severity: 3 })));
  const options = [3, 5, 9, 15];
  // Reference: brute-force every (weighting, k) pair through classifyViaKnn
  // itself, same deterministic folds, first-best-wins tie-break (uniform
  // before distance, smaller k first) — exactly chooseBestK's contract.
  let reference: { k: number; weighting: "uniform" | "distance"; accuracy: number } | null = null;
  for (const weighting of ["uniform", "distance"] as const) {
    for (const k of options) {
      let correct = 0;
      for (let fold = 0; fold < 3; fold++) {
        const train = examples.filter((_, i) => i % 3 !== fold);
        const heldout = examples.filter((_, i) => i % 3 === fold);
        for (const item of heldout) correct += Number(classifyViaKnn(item.embedding, train, k, weighting).relevant === item.kept);
      }
      const accuracy = correct / examples.length;
      if (!reference || accuracy > reference.accuracy) reference = { k, weighting, accuracy };
    }
  }
  assert.deepEqual(chooseBestK(examples, options), reference);
  assert.equal(classifyViaKnn([1, 0], [], 5).confidence, 0);
});

test("distance weighting lets a near-duplicate outvote several loose neighbors", () => {
  // Query sits almost exactly on one KEPT example; three DROPPED examples
  // are further away but still within k=4. Uniform majority says dropped
  // (3 vs 1); inverse-distance weighting says kept.
  const pool = prepareLabeledExamples([
    { id: 1, embedding: [1, 0.02, 0], kept: true, category: "other", severity: 4 },
    { id: 2, embedding: [0.7, 0.7, 0], kept: false, category: null, severity: 1 },
    { id: 3, embedding: [0.7, 0.68, 0.1], kept: false, category: null, severity: 1 },
    { id: 4, embedding: [0.72, 0.66, 0.05], kept: false, category: null, severity: 1 },
  ]);
  const query = [1, 0, 0];
  assert.equal(classifyViaKnn(query, pool, 4, "uniform").relevant, false);
  const weighted = classifyViaKnn(query, pool, 4, "distance");
  assert.equal(weighted.relevant, true);
  assert.equal(weighted.category, "other");
  assert.equal(weighted.severity, 4);
  assert.ok(weighted.confidence > 0.5 && weighted.confidence <= 1);
});

test("source credibility restrictions retain mixed-factual coverage and reject excluded ratings", () => {
  const mixed = { domain: "example.com", bias: "Left-Center", factualRating: "Mixed", credibility: "High" };
  assert.equal(isLowCredibility(mixed), false);
  for (const changed of [{ ...mixed, factualRating: "Low" }, { ...mixed, bias: "Questionable" }, { ...mixed, credibility: "Low" }]) assert.equal(isLowCredibility(changed), true);
  const map = new Map([[mixed.domain, mixed]]);
  assert.equal(lookupCredibility("news.example.com", map), mixed);
  assert.equal(lookupCredibility("notexample.com", map), undefined);
});

test("Gemini client enforces instruction boundary, joins answer parts and ignores thought parts", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    assert.match(request.systemInstruction.parts[0].text, /untrusted evidence/);
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "internal", thought: true }, { text: "[{\"id\":" }, { text: "1}]" }] } }] });
  };
  try { assert.deepEqual(await callGeminiJson("fixture prompt", "test-only"), [{ id: 1 }]); }
  finally { globalThis.fetch = originalFetch; }
});

test("truncated, blocked and invalid Gemini responses remain retryable failures", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  console.error = () => {};
  try {
    for (const finishReason of ["MAX_TOKENS", "SAFETY", "RECITATION"]) {
      globalThis.fetch = async () => Response.json({ candidates: [{ finishReason, content: { parts: [{ text: "[]" }] } }] });
      assert.equal(await callGeminiJson("fixture", "test-only"), null);
    }
    globalThis.fetch = async () => new Response("not json", { status: 200 });
    assert.equal(await callGeminiJson("fixture", "test-only"), null);
  } finally { globalThis.fetch = originalFetch; console.error = originalError; }
});

test("location enrichment cannot put a Russia-attributed event in Kyiv", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify([{ id: 1, lat: 50.45, lon: 30.52, location: "Kyiv" }, { id: 2, lat: 55.75, lon: 37.62, location: "Moscow" }]) }] } }] });
  try {
    const results = await resolveLocationsBatch([{ id: 1, title: "Fixture", snippet: "Fixture", country: "RU" }, { id: 2, title: "Fixture", snippet: "Fixture", country: "RU" }], "test-only");
    assert.equal(results?.has(1), false);
    assert.equal(results?.get(2)?.location, "Moscow");
  } finally { globalThis.fetch = originalFetch; }
});

test("tooltip HTML escapes every interpolated value", async () => {
  const { html, escapeHtml } = await import("../src/lib/html");
  const hostile = '<img src=x onerror="alert(1)">';
  assert.equal(html`<b>${hostile}</b><br/>${42}`, "<b>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</b><br/>42");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml("Tom & Jerry's"), "Tom &amp; Jerry&#39;s");
});

test("outlet suffixes are stripped for display without mangling real headlines", async () => {
  const { stripOutletSuffix } = await import("../src/lib/displayText");
  assert.equal(stripOutletSuffix("Houthis fire ballistic missile at Riyadh | Israel National News"), "Houthis fire ballistic missile at Riyadh");
  assert.equal(stripOutletSuffix("Saudi Arabia confirms Houthi rebels tried to attack its capital | World | The Guardian"), "Saudi Arabia confirms Houthi rebels tried to attack its capital");
  assert.equal(stripOutletSuffix("Yemen's Houthi rebels tried to attack with a ballistic missile - KOCO"), "Yemen's Houthi rebels tried to attack with a ballistic missile");
  assert.equal(stripOutletSuffix("Strikes reported near Kharkiv overnight, officials say – The Times of Israel"), "Strikes reported near Kharkiv overnight, officials say");
  // Content dashes stay: short head, lowercase tail, or sentence-like tail.
  assert.equal(stripOutletSuffix("Ukraine - Russia talks collapse"), "Ukraine - Russia talks collapse");
  assert.equal(stripOutletSuffix("Explosion at oil depot in Volgograd region - officials say no casualties"), "Explosion at oil depot in Volgograd region - officials say no casualties");
  assert.equal(stripOutletSuffix("Iran | Israel"), "Iran | Israel");
});

test("calibration loop: merge threshold, drift-guard parsing and promotion rule", async () => {
  const { shouldMergePattern, guardVerdictAllowsPromotion, parseGuardVerdict } = await import("../src/lib/classifierAudit");
  // Threshold chosen from the live similarity matrix (see the constant's
  // comment): duplicates >= 0.918, genuinely different rules <= 0.902.
  assert.equal(shouldMergePattern(0.965), true);
  assert.equal(shouldMergePattern(0.92), true);
  assert.equal(shouldMergePattern(0.902), false);
  assert.equal(shouldMergePattern(null), false);
  // Only refinements and genuinely new rules may auto-promote.
  assert.equal(guardVerdictAllowsPromotion("narrows"), true);
  assert.equal(guardVerdictAllowsPromotion("new"), true);
  for (const v of ["restates", "widens", "contradicts"] as const) assert.equal(guardVerdictAllowsPromotion(v), false);
  // Guard answers are parsed defensively: array-wrapped, case-insensitive,
  // reasoning capped; anything off-vocabulary is a non-answer (re-asked
  // later), never a default that promotes.
  assert.deepEqual(parseGuardVerdict([{ verdict: " Widens ", reasoning: "drops the presstv-only scope" }]), { verdict: "widens", reasoning: "drops the presstv-only scope" });
  assert.equal(parseGuardVerdict([{ verdict: "approve" }]), null);
  assert.equal(parseGuardVerdict([]), null);
  assert.equal(parseGuardVerdict("narrows"), null);
  assert.equal(parseGuardVerdict({ verdict: "new" })?.verdict, "new");
});

test("structural sources are identified by exact name", async () => {
  const { isStructuralSource, STRUCTURAL_SOURCES } = await import("../src/lib/structuralSources");
  for (const s of STRUCTURAL_SOURCES) assert.equal(isStructuralSource(s), true);
  for (const s of ["gdelt", "rss:al-jazeera", "telegram:presstv", "usgs2", ""]) assert.equal(isStructuralSource(s), false);
});

test("quote timestamps are described honestly by source and age", async () => {
  const { describeAsOf, newestAsOf } = await import("../src/lib/asOf");
  const now = Date.parse("2026-09-20T12:00:00Z");
  assert.equal(describeAsOf("2026-09-20T11:59:40Z", "market", now), "just now");
  assert.equal(describeAsOf("2026-09-20T11:35:00Z", "market", now), "25 min ago");
  assert.equal(describeAsOf("2026-09-20T03:00:00Z", "market", now), "9 h ago");
  assert.equal(describeAsOf("2026-09-18T21:00:00Z", "market", now), "last trade 2026-09-18");
  assert.equal(describeAsOf("2026-09-15T00:00:00.000Z", "reference", now), "daily fixing, 2026-09-15");
  const rows = [{ asOf: "2026-09-18T00:00:00Z", source: "reference" as const }, { asOf: "2026-09-20T02:00:00Z", source: "market" as const }];
  assert.equal(newestAsOf(rows)?.source, "market");
  assert.equal(newestAsOf([]), null);
});

test("every chokepoint is attributed to real littoral states", async () => {
  const { CHOKEPOINT_COUNTRIES } = await import("../src/lib/chokepointHistory");
  const { ISO_NUMERIC_TO_ALPHA2 } = await import("../src/lib/isoCountries");
  const known = new Set(Object.values(ISO_NUMERIC_TO_ALPHA2));
  // PortWatch publishes exactly 28 chokepoints; an unmapped one would be
  // silently dropped from the signal (see getChokepointAnomalyOutcomes),
  // so the map has to keep pace with the source rather than drift.
  assert.equal(Object.keys(CHOKEPOINT_COUNTRIES).length, 28);
  for (const [point, countries] of Object.entries(CHOKEPOINT_COUNTRIES)) {
    assert.ok(countries.length > 0, `${point} has no country`);
    for (const c of countries) {
      assert.match(c, /^[A-Z]{2}$/, `${point}: ${c} is not an ISO2 code`);
      assert.ok(known.has(c), `${point}: ${c} is not a country this app can place`);
    }
  }
  // The passages the brief names explicitly, each on the right shore.
  assert.deepEqual(CHOKEPOINT_COUNTRIES["Strait of Hormuz"], ["IR", "OM", "AE"]);
  assert.deepEqual(CHOKEPOINT_COUNTRIES["Kerch Strait"], ["RU", "UA"]);
  assert.deepEqual(CHOKEPOINT_COUNTRIES["Suez Canal"], ["EG"]);
});

test("a chokepoint finding names the passage, not a category code", async () => {
  const { signalDescription, signalName } = await import("../src/lib/anomalyLabels");
  // `category` carries an event category for one signal and a chokepoint
  // name for another; the description must not run a strait through the
  // CATEGORY_LABELS lookup and render it as a bare slug.
  const finding = {
    signalType: "chokepoint-transit",
    country: "ES",
    category: "Gibraltar Strait",
    observedValue: 96,
    baselineMean: 132.5,
    baselineStdDev: 11.8,
    sampleSize: 28,
    jump: -36.5,
    zScore: 3.1,
  };
  const text = signalDescription(finding);
  assert.ok(text.startsWith("Gibraltar Strait vessel transits down to 96"), text);
  assert.ok(text.includes("132.5"), text);
  assert.equal(signalName("chokepoint-transit"), "maritime chokepoint transits");
});

test("sanctions programmes map to a country only when the programme names one", async () => {
  const { programCountry } = await import("../src/lib/sanctions");
  // Country programmes, including OFAC's executive-order suffixes and its
  // bracket-joined multi-programme strings.
  assert.equal(programCountry("ofac", "IRAN-EO13902"), "IR");
  assert.equal(programCountry("ofac", "UKRAINE-EO13662"), "UA");
  assert.equal(programCountry("ofac", "SDGT, IFSR"), "IR");
  assert.equal(programCountry("eu", "IRN"), "IR");
  assert.equal(programCountry("eu", "BLR"), "BY");
  // Thematic programmes have no country and must not be forced onto the
  // designating state — an SDGT listing is not a signal about the US.
  assert.equal(programCountry("ofac", "SDGT"), null);
  assert.equal(programCountry("ofac", "SDNT"), null);
  assert.equal(programCountry("eu", "TERR"), null);
  assert.equal(programCountry("ofac", null), null);
});

test("alert tiers: a standing crisis is not news, a real escalation is", async () => {
  const { assessAlert } = await import("../src/lib/alertScoring");
  // A country that has been at level 4 with heavy coverage for months.
  // Scores high on every standing component and must still produce
  // nothing, because nothing changed.
  const standing = {
    level: 4, previousLevel: 4, momentum: 70, previousMomentum: 70,
    maxSeverity: 5, sourceFamilies: 6, anomalySignals: 2, previousAnomalySignals: 2, pillarsActive: 3,
  };
  assert.equal(assessAlert(standing).tier, null);
  assert.ok(assessAlert(standing).score >= 55, "the standing score is high — the change gate is what stops it");

  // The same country escalating one level: news.
  assert.equal(assessAlert({ ...standing, previousLevel: 3 }).tier, "FLASH");
  // A new unusual signal alone is enough to be worth looking at.
  assert.ok(assessAlert({ ...standing, previousAnomalySignals: 1 }).tier !== null);
});

test("FLASH needs a rise, a serious level, and independent corroboration", async () => {
  const { assessAlert } = await import("../src/lib/alertScoring");
  const flashy = {
    level: 4, previousLevel: 2, momentum: 85, previousMomentum: 40,
    maxSeverity: 5, sourceFamilies: 4, anomalySignals: 2, previousAnomalySignals: 0, pillarsActive: 3,
  };
  assert.equal(assessAlert(flashy).tier, "FLASH");

  // One outlet saying it, however loudly, is not FLASH.
  const single = assessAlert({ ...flashy, sourceFamilies: 1 });
  assert.notEqual(single.tier, "FLASH");
  assert.ok(single.gateNotes.some((n) => n.includes("source family")), single.gateNotes.join("; "));

  // A surge that never reaches a serious level is not FLASH either.
  const lowLevel = assessAlert({ ...flashy, level: 2, previousLevel: 1 });
  assert.notEqual(lowLevel.tier, "FLASH");
});

test("alert cooldown lengthens with repeats but never blocks an escalation", async () => {
  const { shouldSuppress, cooldownHoursFor } = await import("../src/lib/alertScoring");
  assert.deepEqual([0, 1, 2, 3, 9].map(cooldownHoursFor), [0, 6, 12, 24, 24]);
  // Nothing before it: always goes out.
  assert.equal(shouldSuppress("WATCH", null, null, 0).suppressed, false);
  // Same tier, inside the window: held.
  assert.equal(shouldSuppress("PRIORITY", "PRIORITY", 1, 1).suppressed, true);
  // Same tier, past the window: goes out.
  assert.equal(shouldSuppress("PRIORITY", "PRIORITY", 7, 1).suppressed, false);
  // Escalation ignores the cooldown entirely — being told a country just
  // got materially worse matters more than having mentioned it an hour ago.
  assert.equal(shouldSuppress("FLASH", "PRIORITY", 0.1, 3).suppressed, false);
  // De-escalation does not.
  assert.equal(shouldSuppress("WATCH", "PRIORITY", 0.1, 1).suppressed, true);
});

test("a fired alert can be recomputed from its own stored inputs", async () => {
  const { assessAlert } = await import("../src/lib/alertScoring");
  // The columns the alerts table stores are exactly the scorer's inputs;
  // this is what makes an alert auditable months later rather than an
  // opinion with a colour. Values here are a real row from the first live
  // evaluation (Russia, 2026-09-22).
  const stored = {
    level: 4, previousLevel: 3, momentum: 46, previousMomentum: 46,
    maxSeverity: 4, sourceFamilies: 5, anomalySignals: 1, previousAnomalySignals: 1, pillarsActive: 2,
  };
  const again = assessAlert(stored);
  assert.equal(again.tier, "PRIORITY");
  assert.equal(again.score, 76);
  assert.equal(again.components.reduce((s, c) => s + c.points, 0), again.score);
});

test("an overloaded model API stops the brief run instead of grinding through 120 countries", async () => {
  const { isUpstreamUnavailableStatus } = await import("../src/lib/countryBriefs");
  // 2026-09-22: Gemini returned 503 "high demand" continuously and the
  // loop treated it as a per-country miss, walking the ranked list at up
  // to 20s each until the runner's job ceiling killed the workflow.
  assert.equal(isUpstreamUnavailableStatus(503), true);
  assert.equal(isUpstreamUnavailableStatus(500), true);
  assert.equal(isUpstreamUnavailableStatus(429), true);
  // Not the upstream's capacity — this request or this key. Trying the
  // next country is still the right move.
  assert.equal(isUpstreamUnavailableStatus(400), false);
  assert.equal(isUpstreamUnavailableStatus(403), false);
  assert.equal(isUpstreamUnavailableStatus(404), false);
});

test("an alert with nothing to show does not fire", async () => {
  const { assessAlert, hasEvidence } = await import("../src/lib/alertScoring");
  // Found in the first day of real output: ROUTINE rows reading
  // "momentum 38 to 68" with no driving events and no evidence. Momentum
  // is a ratio against a prior window, so it climbs when old events decay
  // out of the denominator — nothing happened, the arithmetic moved.
  const empty = {
    level: 3, previousLevel: 3, momentum: 68, previousMomentum: 38,
    maxSeverity: 0, sourceFamilies: 0, anomalySignals: 0, previousAnomalySignals: 0, pillarsActive: 0,
  };
  assert.equal(hasEvidence(empty), false);
  assert.equal(assessAlert(empty).tier, null);
  assert.ok(assessAlert(empty).gateNotes.some((n) => n.includes("nothing to show")));

  // A sensor spike with no news coverage is exactly the signal worth
  // keeping, so an anomaly alone counts as evidence.
  assert.equal(hasEvidence({ ...empty, anomalySignals: 1 }), true);
  assert.notEqual(assessAlert({ ...empty, anomalySignals: 1, previousAnomalySignals: 0 }).tier, null);
  // So does a single driving event.
  assert.equal(hasEvidence({ ...empty, sourceFamilies: 1 }), true);
});

test("a hazard in an empty place outscores nothing; the same hazard in a city does not", async () => {
  const { populationNear, exposureMultiplier } = await import("../src/lib/exposure");
  // A capital and its suburbs, and an empty stretch 20 degrees away.
  const centers = [
    { lat: 35.68, lon: 139.69, population: 8_300_000 },
    { lat: 35.45, lon: 139.63, population: 3_700_000 },
    { lat: 35.61, lon: 140.11, population: 970_000 },
  ];
  const city = populationNear(35.68, 139.69, centers);
  const desert = populationNear(15.0, 120.0, centers);
  assert.ok(city > 10_000_000, `expected millions near the capital, got ${city}`);
  assert.equal(desert, 0);
  // The whole point of the model: the same magnitude, weighted differently.
  assert.ok(exposureMultiplier(city) > exposureMultiplier(desert));
  assert.equal(exposureMultiplier(desert), 0.4); // clamped floor
  assert.equal(exposureMultiplier(city), 1.6); // clamped ceiling

  // Distance decay: a city on the rim of the radius counts for less than
  // one underfoot.
  const near = populationNear(35.68, 139.69, [{ lat: 35.68, lon: 139.69, population: 100_000 }]);
  const far = populationNear(35.68, 139.69, [{ lat: 36.48, lon: 139.69, population: 100_000 }]);
  assert.ok(far < near && far > 0, `${far} should be between 0 and ${near}`);
});

test("unknown exposure is never treated as zero exposure", async () => {
  const { exposureMultiplier } = await import("../src/lib/exposure");
  // The distinction that keeps "we don't know" from becoming "this didn't
  // matter": null is an event from before the model, -1 is the backfill's
  // "checked, not applicable" sentinel. Both must be neutral, NOT the 0.4
  // floor that a genuinely empty location earns.
  assert.equal(exposureMultiplier(null), 1);
  assert.equal(exposureMultiplier(-1), 1);
  assert.equal(exposureMultiplier(0), 0.4);
  // The anchor is the measured median hazard exposure, so a typical event
  // is left exactly where it was.
  assert.ok(Math.abs(exposureMultiplier(10_000) - 1) < 0.02);
});

test("exposure weighting applies to hazards only, never to political events", async () => {
  const { isExposureWeighted } = await import("../src/lib/exposure");
  for (const c of ["earthquake", "natural-disaster", "climate-hazard"]) {
    assert.equal(isExposureWeighted(c), true, c);
  }
  // Weighting these by population would encode "events in crowded
  // countries matter more", which is a bias, not a correction.
  for (const c of ["political-instability", "humanitarian", "russia-ukraine", "us-iran", "other"]) {
    assert.equal(isExposureWeighted(c), false, c);
  }
});

test("the SQL and JS exposure curves are built from the same constants", async () => {
  const { exposureMultiplierSqlExpr } = await import("../src/lib/exposure");
  // The weight is summed in Postgres, so the curve exists twice. These
  // are the numbers that must not drift apart; the algebra is pinned by
  // the multiplier assertions above.
  const expr = exposureMultiplierSqlExpr("population_exposed", "category");
  assert.match(expr, /least\(1\.6/);
  assert.match(expr, /greatest\(0\.4/);
  assert.match(expr, /0\.3 \* log\(10/);
  assert.match(expr, /10000/);
  assert.match(expr, /'earthquake'/);
  assert.match(expr, /population_exposed >= 0/);
  assert.doesNotMatch(expr, /'political-instability'/);
});

// ---------------------------------------------------------------------
// Scoring version 3 (2026-09-23): stories not articles, corroboration,
// sensor saturation, recalibrated Pulse Levels. See src/lib/scoringMethod.ts.

test("corroboration rewards independent confirmation, with diminishing and capped returns", async () => {
  const { corroborationMultiplier, CORROBORATION_MAX } = await import("../src/lib/scoringMethod");
  assert.equal(corroborationMultiplier(0), 1);
  assert.equal(corroborationMultiplier(-3), 1);
  assert.equal(corroborationMultiplier(NaN), 1);
  assert.ok(Math.abs(corroborationMultiplier(1) - 1.2) < 1e-9);
  assert.ok(Math.abs(corroborationMultiplier(3) - 1.4) < 1e-9);
  assert.equal(corroborationMultiplier(7), CORROBORATION_MAX);
  assert.equal(corroborationMultiplier(500), CORROBORATION_MAX);
  // The point of the change: five outlets carrying one story used to
  // score 5x. Now it scores well under 2x.
  assert.ok(corroborationMultiplier(4) < 2);
});

test("corroboration SQL and JS agree on the curve", async () => {
  const { corroborationMultiplierSqlExpr, CORROBORATION_STEP, CORROBORATION_MAX } = await import("../src/lib/scoringMethod");
  const expr = corroborationMultiplierSqlExpr(`"c"."sources"`);
  assert.ok(expr.includes(`least(${CORROBORATION_MAX},`));
  assert.ok(expr.includes(`${CORROBORATION_STEP} * log(2,`));
  // A story with no duplicates has no corroboration row at all (LEFT
  // JOIN -> NULL); it must mean "zero extra sources", not NULL weight.
  assert.ok(expr.includes(`coalesce("c"."sources", 0)`));
});

test("one automated sensor can make a country High, never Extreme, on its own", async () => {
  const { saturateSensorWeight, SENSOR_SATURATION } = await import("../src/lib/scoringMethod");
  const { weightToThreatLevel } = await import("../src/lib/threat");
  const { PILLAR_WEIGHT } = await import("../src/lib/pillars");
  const hazards = PILLAR_WEIGHT["natural-biological-hazards"];
  // Brazil, 2026-09-23: 189 FIRMS clusters, raw decayed load ~138.
  const brazilFires = saturateSensorWeight(138) * hazards;
  assert.equal(weightToThreatLevel(brazilFires), 3);
  // However much the instrument reports.
  assert.ok(saturateSensorWeight(1e9) <= SENSOR_SATURATION);
  assert.ok(weightToThreatLevel(saturateSensorWeight(1e9) * hazards) < 4);
  // A handful of detections still counts almost in full.
  assert.ok(saturateSensorWeight(2) > 1.9);
  assert.equal(saturateSensorWeight(0), 0);
  assert.equal(saturateSensorWeight(-5), 0);
});

test("news is never saturated; only the named detection feeds are", async () => {
  const { isSensorSource } = await import("../src/lib/scoringMethod");
  for (const s of ["firms", "usgs", "eonet"]) assert.ok(isSensorSource(s), s);
  for (const s of ["gdelt", "gdacs", "rss:bbc-world", "telegram:kpszsu", "ioda"]) assert.ok(!isSensorSource(s), s);
});

test("Pulse Level thresholds mean what threat.ts says they mean", async () => {
  const { weightToThreatLevel } = await import("../src/lib/threat");
  const { PILLAR_WEIGHT } = await import("../src/lib/pillars");
  // Steady-state load of r severity-3 security stories a day under a
  // 3-day half-life: r * 3 * 1.5 / (ln2 / 3).
  const steady = (perDay: number) => (perDay * 3 * PILLAR_WEIGHT["geopolitical-security"]) / (Math.LN2 / 3);
  assert.equal(weightToThreatLevel(steady(4)), 4);
  assert.equal(weightToThreatLevel(steady(3)), 3);
  assert.equal(weightToThreatLevel(steady(1.1)), 3);
  assert.equal(weightToThreatLevel(steady(0.2)), 1);
  assert.equal(weightToThreatLevel(steady(0.25)), 2);
});

test("a sensor spanning two categories of one pillar is saturated once, not per category", async () => {
  const { aggregateByCountryAndPillar } = await import("../src/lib/risk");
  const { SENSOR_SATURATION } = await import("../src/lib/scoringMethod");
  const { PILLAR_WEIGHT } = await import("../src/lib/pillars");
  const row = (category: string) => ({
    country: "BR", category, sensorSource: "firms", decayedWeight: 500,
    recent24h: 0, prior24h: 0, recent7d: 0, prior7d: 0, eventCount: 1, lastEventAt: "2026-09-23",
  });
  const out = aggregateByCountryAndPillar([row("natural-disaster"), row("earthquake")]);
  const w = out.get("BR")!.get("natural-biological-hazards")!.decayedWeight;
  assert.ok(w <= SENSOR_SATURATION * PILLAR_WEIGHT["natural-biological-hazards"] + 1e-9);
});

test("USGS places resolve to the country that owns them", async () => {
  const { usgsPlaceCountry } = await import("../src/lib/sources/usgs");
  assert.equal(usgsPlaceCountry("41 km SW of Karluk, Alaska"), "US");
  assert.equal(usgsPlaceCountry("5 km N of Ridgecrest, CA"), "US");
  assert.equal(usgsPlaceCountry("off the coast of Oregon"), "US");
  assert.equal(usgsPlaceCountry("12 km E of Dili, Timor Leste"), "TL");
  // "Gambiran" contains "iran": a live event was once filed under Iran.
  assert.equal(usgsPlaceCountry("3 km ESE of Gambiran Satu, Indonesia"), "ID");
  // USGS writes the Caucasus country as plain "Georgia".
  assert.equal(usgsPlaceCountry("20 km N of Tbilisi, Georgia"), "GE");
  // Open ocean stays unplaced rather than guessed.
  assert.equal(usgsPlaceCountry("southern Mid-Atlantic Ridge"), null);
});

test("feed cards lift Telegram attribution out of the text without dropping the disclosure", async () => {
  const { splitAttribution } = await import("../src/lib/displayText");
  const t = splitAttribution("Ukrainian Air Force (official) [translated from Ukrainian]: Attack UAVs toward Zaporizhzhia", "telegram:kpszsu");
  assert.equal(t.body, "Attack UAVs toward Zaporizhzhia");
  assert.equal(t.translatedFrom, "Ukrainian");
  assert.equal(splitAttribution("PressTV (Iranian state media): Statement on talks", "telegram:presstv").translatedFrom, null);
  assert.equal(splitAttribution("PressTV (Iranian state media): Statement on talks", "telegram:presstv").body, "Statement on talks");
  // News is left exactly as stored — a colon in a headline is content.
  const news = "Explainer: what the ceasefire means";
  assert.equal(splitAttribution(news, "rss:bbc-world").body, news);
});

test("a country's Pulse Level explanation states the rule the model actually applied", async () => {
  const { explainPulseLevel, escalateThreatLevel } = await import("../src/lib/threat");
  const p = (shortLabel: string, threatLevel: 1 | 2 | 3 | 4, covered = true) => ({ shortLabel, threatLevel, covered });
  const single = [p("Security", 4), p("Hazards", 1)];
  assert.match(explainPulseLevel(single), /^Security is Extreme: /);
  // Two pillars at High lift the country to Extreme — the explanation has
  // to say so, or "Extreme" would appear with no Extreme pillar to show.
  const lifted = [p("Security", 3), p("Hazards", 3)];
  assert.equal(escalateThreatLevel([3, 3]), 4);
  assert.match(explainPulseLevel(lifted), /lifts the overall reading one level to Extreme/);
  // Uncovered pillars never feature in the reason.
  assert.doesNotMatch(explainPulseLevel([p("Security", 2), p("Cyber", 4, false)]), /Cyber/);
  assert.match(explainPulseLevel([p("Security", 1)]), /^No pillar is above Low/);
});

test("GDELT discovery reads every 15-minute file in its window, not just the newest", async () => {
  const { recentExportCsvUrls } = await import("../src/lib/sources/gdeltBulk");
  const urls = recentExportCsvUrls("http://data.gdeltproject.org/gdeltv2/20260923231500.export.CSV.zip", 5);
  assert.deepEqual(urls.map((u) => u.slice(-29, -15)), [
    "20260923231500", "20260923230000", "20260923224500", "20260923223000", "20260923221500",
  ]);
  // HTTPS: the plain-HTTP host 301s every request.
  assert.ok(urls.every((u) => u.startsWith("https://data.gdeltproject.org/gdeltv2/")));
  // Across midnight and a month boundary, slots still step back 15 minutes.
  const midnight = recentExportCsvUrls("https://data.gdeltproject.org/gdeltv2/20261001000000.export.CSV.zip", 2);
  assert.ok(midnight[1].endsWith("20260930234500.export.CSV.zip"));
  // A name it cannot parse is used as-is rather than guessed around.
  assert.deepEqual(recentExportCsvUrls("https://x/odd.zip", 5), ["https://x/odd.zip"]);
});

test("the pipeline alarm stays quiet on a healthy day and names each quiet failure", async () => {
  const { evaluatePipelineHealth } = await import("../src/lib/pipelineHealth");
  const healthy = {
    feedEmbeddingBacklog: 12, keptArchiveBacklog: 2675, embeddingsToday: 620,
    oldestPendingReviewHours: 0.5, gdeltQueueWaiting: 620,
    events24hBySource: { gdelt: 170, rss: 74, telegram: 49, usgs: 0 },
    hoursSinceSourceSuccess: { gdelt: 0.3, rss: 0.3, usgs: 0.3 },
  };
  // A quiet day for a hazard feed (usgs: 0) is real, not a failure.
  assert.deepEqual(evaluatePipelineHealth(healthy), []);
  // Each of 2026-09-23's silent problems would now fail the run:
  assert.match(evaluatePipelineHealth({ ...healthy, feedEmbeddingBacklog: 267 }).join(), /published events have no embedding/);
  assert.match(evaluatePipelineHealth({ ...healthy, oldestPendingReviewHours: 52 }).join(), /pending review for 52\.0 h/);
  assert.match(evaluatePipelineHealth({ ...healthy, embeddingsToday: 0 }).join(), /Gemini key/);
  assert.match(evaluatePipelineHealth({ ...healthy, events24hBySource: { rss: 74, telegram: 49 } }).join(), /No gdelt events/);
  assert.match(evaluatePipelineHealth({ ...healthy, hoursSinceSourceSuccess: { gdelt: Infinity } }).join(), /gdelt has not fetched/);
  // No pending items at all is healthy, not "unknown".
  assert.deepEqual(evaluatePipelineHealth({ ...healthy, oldestPendingReviewHours: null }), []);
});
