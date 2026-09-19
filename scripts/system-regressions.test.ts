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
