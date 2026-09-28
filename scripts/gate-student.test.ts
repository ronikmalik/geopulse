import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateGateStudent, gateFeatureNames, rocAuc, type GateExample } from "../src/lib/gateStudent";

// Synthetic gate decisions shaped like the real policy: reports of a strike
// or casualties are published, statements and warnings are not. Pure
// functions only; nothing here touches a database or the network.
function examples(n: number): GateExample[] {
  const kinetic = ["missile strike kills three in", "drone attack hits power plant in", "shelling wounds civilians in"];
  const rhetoric = ["foreign minister condemns remarks by", "president warns of consequences for", "spokesman rejects claims about"];
  const places = ["Kharkiv", "Odesa", "Sanaa", "Beirut", "Gaza", "Tehran"];
  const out: GateExample[] = [];
  for (let i = 0; i < n; i++) {
    const publish = i % 3 === 0;
    const phrase = (publish ? kinetic : rhetoric)[i % 3];
    out.push({
      text: `${phrase} ${places[i % places.length]} on day ${i % 7}`,
      source: i % 2 ? "gdelt" : "rss:bbc-world",
      category: "russia-ukraine",
      label: publish ? 1 : 0,
      at: new Date(Date.UTC(2026, 8, 18) + i * 3_600_000),
    });
  }
  return out;
}

test("gate student learns the publish/reject distinction and beats the source-prior baseline", () => {
  const ev = evaluateGateStudent(examples(600));
  assert.equal(ev.trained, true);
  assert.equal(ev.trainSize + ev.testSize, 600);
  assert.ok((ev.metrics.auc as number) > 0.95, `auc ${ev.metrics.auc}`);
  assert.ok((ev.metrics.auc as number) > (ev.baseline!.auc as number));
  assert.ok((ev.metrics.logLoss as number) < (ev.baseline!.logLoss as number));
  for (const t of [0.8, 0.9, 0.95]) {
    assert.ok(typeof ev.metrics[`coverage@${t}`] === "number");
  }
  assert.match(String(ev.metrics.publishLeaning), /strike|kills|hits|wounds|attack/);
  assert.match(String(ev.metrics.rejectLeaning), /condemns|warns|rejects/);
});

test("gate student holds out the newest decisions, not a random sample", () => {
  const data = examples(300);
  const ev = evaluateGateStudent([...data].reverse());
  // Same rows in any input order produce the same split and the same scores.
  assert.deepEqual(ev, evaluateGateStudent(data));
  assert.equal(ev.testSize, 60);
});

test("gate student reports insufficient data instead of a misleading score", () => {
  const ev = evaluateGateStudent(examples(50));
  assert.equal(ev.trained, false);
  assert.match(ev.notes, /insufficient data/);
  const oneClass = examples(300).map((e) => ({ ...e, label: 0 as const }));
  assert.equal(evaluateGateStudent(oneClass).trained, false);
});

test("ROC AUC counts ties as half and is undefined without both classes", () => {
  assert.equal(rocAuc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1]), 0.75);
  assert.equal(rocAuc([0.5, 0.5], [0, 1]), 0.5);
  assert.equal(rocAuc([0.2, 0.3], [1, 1]), null);
});

test("features include words, word pairs, source and category, without function words", () => {
  const names = gateFeatureNames({ text: "The strike on the port", source: "rss:bbc-world", category: "us-iran" });
  assert.ok(names.includes("w:strike"));
  assert.ok(names.includes("b:strike_on"));
  assert.ok(names.includes("src:rss"));
  assert.ok(names.includes("srcx:rss:bbc-world"));
  assert.ok(names.includes("cat:us-iran"));
  assert.ok(!names.includes("w:the"));
});
