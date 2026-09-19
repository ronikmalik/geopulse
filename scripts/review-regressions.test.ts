import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { neonConfig } from "@neondatabase/serverless";
import { splitByAvailableOutcome, predictionTargetAt } from "../src/lib/temporalSplit";
import { buildRegressionExamples, findClosestSnapshot, type Snapshot } from "../src/lib/riskModel";
import { trainLinearRegression, predict } from "../src/lib/linearRegression";
import { trainGradientBoostedTrees, predictGbm } from "../src/lib/gradientBoostedTrees";
import { isCronAuthorized } from "../src/lib/cronAuth";
import { parseCountryParam, parseIdParam, parseCategoriesParam, parseBoundedInt, cachedJson } from "../src/lib/apiParams";
import { getDuplicatesOf } from "../src/lib/eventDedup";
import { runKMeans } from "../src/lib/narrativeClustering";

const day = (n: number, hour = 18) => new Date(Date.UTC(2026, 8, n, hour));

test("narrative model selection includes singleton clusters as zero silhouette", () => {
  const result = runKMeans([[1, 0], [1, 0], [0, 1]], 2, () => 0.5);
  assert.ok(Math.abs(result.silhouetteScore - 2 / 3) < 1e-10);
});

test("forecast split purges overlapping labels and keeps countries at the same timestamp together", () => {
  const examples = Array.from({ length: 10 }, (_, i) => ["US", "GB", "FR"].map((country) => ({
    country, snapshotAt: day(i + 1), targetAt: day(i + 4),
  }))).flat().reverse();
  const { train, test: heldout } = splitByAvailableOutcome(examples, 0.25);
  assert.equal(heldout[0].snapshotAt.getTime(), day(8).getTime());
  assert.equal(train.length, 12);
  assert.equal(heldout.length, 9);
  assert.ok(train.every((e) => e.targetAt < heldout[0].snapshotAt));
  assert.ok(!train.some((e) => heldout.some((h) => +e.snapshotAt === +h.snapshotAt)));
});

test("purging uses the actual matched outcome time, including snapshot jitter", () => {
  const examples = Array.from({ length: 5 }, (_, i) => ({ snapshotAt: day(i + 1), targetAt: day(i + 2) }));
  examples[2].targetAt = day(5, 19);
  const { train, test: heldout } = splitByAvailableOutcome(examples, 0.2);
  assert.equal(heldout.length, 1);
  assert.equal(train.length, 2);
});

test("insufficient history yields no train set rather than leaking long-horizon labels", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ snapshotAt: day(i + 1), targetAt: day(i + 15) }));
  assert.equal(splitByAvailableOutcome(rows, 0.2).train.length, 0);
  assert.deepEqual(splitByAvailableOutcome([], 0.2), { train: [], test: [] });
});

test("one timestamp cannot occur on both sides of the split", () => {
  const rows = Array.from({ length: 40 }, () => ({ snapshotAt: day(1), targetAt: day(2) }));
  const split = splitByAvailableOutcome(rows, 0.2);
  assert.equal(split.train.length, 0);
  assert.equal(split.test.length, 40);
});

test("invalid split fractions are rejected", () => {
  for (const fraction of [0, 1, -0.2, NaN]) assert.throws(() => splitByAvailableOutcome([], fraction));
});

test("forecast target follows the input snapshot clock, not the noon training schedule", () => {
  const lastSnapshot = day(12, 18);
  const trainingTime = day(13, 12);
  assert.equal(predictionTargetAt(lastSnapshot, 1).toISOString(), day(13, 18).toISOString());
  assert.notEqual(+predictionTargetAt(lastSnapshot, 1), +predictionTargetAt(trainingTime, 1));
});

test("regression examples preserve actual target timestamps after burn-in", () => {
  const snapshots: Snapshot[] = Array.from({ length: 12 }, (_, i) => ({
    country: "US", snapshotAt: day(i + 1), score: i, threatLevel: 1,
    momentum: 0, momentumDirection: 0, eventCount: i,
  }));
  const examples = buildRegressionExamples(snapshots, [], 1);
  assert.equal(examples.length, 4);
  assert.equal(+examples[0].snapshotAt, +day(8));
  assert.equal(+examples[0].targetAt, +day(9));
  assert.equal(examples[0].targetScore, 8);
});

test("snapshot matching rejects gaps beyond six hours and selects the closest outcome", () => {
  assert.equal(findClosestSnapshot([{ snapshotAt: day(2, 11) }], +day(2)), null);
  const rows = [{ snapshotAt: day(2, 13) }, { snapshotAt: day(2, 19) }];
  assert.equal(findClosestSnapshot(rows, +day(2)), rows[1]);
});

test("both forecasting models fit finite predictions with a purged inner split", () => {
  const x = Array.from({ length: 40 }, (_, i) => [i, 1]);
  const y = x.map(([i]) => 2 * i + 3);
  const split = { train: Array.from({ length: 24 }, (_, i) => i), test: Array.from({ length: 10 }, (_, i) => i + 30) };
  const linear = trainLinearRegression(x, y, undefined, split).model;
  const gbm = trainGradientBoostedTrees(x, y, undefined, split).model;
  assert.ok(Math.abs(predict(linear, [20, 1]) - 43) < 3);
  assert.ok(Math.abs(predictGbm(gbm, [20, 1]) - 43) < 8);
});

test("small purged inner sets select conservative defaults without empty-data fits", () => {
  const x = [[1], [2], [3], [4], [5]];
  const y = [7, 7, 7, 7, 7];
  const split = { train: [], test: [4] };
  const linear = trainLinearRegression(x, y, undefined, split);
  const gbm = trainGradientBoostedTrees(x, y, undefined, split);
  assert.equal(linear.selectedL2, 10);
  assert.equal(gbm.selectedNEstimators, 10);
  assert.equal(predict(linear.model, [8]), 7);
  assert.equal(predictGbm(gbm.model, [8]), 7);
});

test("admin authentication fails closed outside explicit development", () => {
  const saved = { ...process.env };
  try {
    delete process.env.CRON_SECRET;
    for (const mode of ["production", "test", ""]) {
      Object.assign(process.env, { NODE_ENV: mode });
      assert.equal(isCronAuthorized(new NextRequest("https://example.com/api/admin/purge")), false);
    }
    Object.assign(process.env, { NODE_ENV: "development" });
    assert.equal(isCronAuthorized(new NextRequest("http://localhost/api/ingest")), true);
    Object.assign(process.env, { NODE_ENV: "production", CRON_SECRET: "test-only-secret" });
    assert.equal(isCronAuthorized(new NextRequest("https://example.com/api/ingest", { headers: { authorization: "Bearer test-only-secret" } })), true);
    assert.equal(isCronAuthorized(new NextRequest("https://example.com/api/ingest?secret=test-only-secret")), true);
    assert.equal(isCronAuthorized(new NextRequest("https://example.com/api/ingest?secret=wrong")), false);
    // Destructive routes refuse the query-param form entirely — a leaked
    // access-log line must never be enough to purge or migrate.
    assert.equal(isCronAuthorized(new NextRequest("https://example.com/api/admin/purge?secret=test-only-secret"), { headerOnly: true }), false);
    assert.equal(isCronAuthorized(new NextRequest("https://example.com/api/admin/purge", { headers: { authorization: "Bearer test-only-secret" } }), { headerOnly: true }), true);
    // Prefix/suffix of the real secret must not pass (length mismatch path).
    assert.equal(isCronAuthorized(new NextRequest("https://example.com/api/ingest", { headers: { authorization: "Bearer test-only-secre" } })), false);
    assert.equal(isCronAuthorized(new NextRequest("https://example.com/api/ingest", { headers: { authorization: "Basic test-only-secret" } })), false);
  } finally {
    process.env = saved;
  }
});

test("public route parameters are validated before any work happens", () => {
  assert.equal(parseCountryParam("ua"), "UA");
  assert.equal(parseCountryParam(" IR "), "IR");
  for (const bad of [null, "", "U", "USA", "u1", "..", "UA; drop table events"]) assert.equal(parseCountryParam(bad), null);
  assert.equal(parseIdParam("42"), 42);
  for (const bad of [null, "", "0", "-1", "4.2", "abc", "9".repeat(20)]) assert.equal(parseIdParam(bad), null);
  assert.deepEqual(parseCategoriesParam("us-iran, humanitarian ,us-iran"), ["us-iran", "humanitarian"]);
  for (const bad of [null, "", " , ", "us-iran,made-up", "OTHER"]) assert.equal(parseCategoriesParam(bad), null);
  assert.equal(parseBoundedInt("9999", 365, 1, 730), 730);
  assert.equal(parseBoundedInt("x", 365, 1, 730), 365);
  assert.equal(parseBoundedInt("0", 365, 1, 730), 1);
  const cached = cachedJson({ ok: true }, 30, 60);
  assert.equal(cached.headers.get("cache-control"), "public, max-age=0, s-maxage=30, stale-while-revalidate=60");
});

test("public duplicate lookup constrains both child and primary visibility", async () => {
  const originalUrl = process.env.DATABASE_URL;
  const originalFetch = neonConfig.fetchFunction;
  process.env.DATABASE_URL = "postgresql://test:test@example.invalid/test";
  const queries: string[] = [];
  neonConfig.fetchFunction = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    queries.push(body.query);
    return new Response(JSON.stringify({ fields: [], rows: [], rowCount: 0, command: "SELECT" }), { status: 200 });
  };
  try {
    assert.deepEqual(await getDuplicatesOf(123), []);
    assert.equal(queries.length, 1);
    assert.match(queries[0], /"events"\."review_status" =/);
    assert.match(queries[0], /"events"\."pre_kill_switch_at" is null/);
    assert.match(queries[0], /primary_event\.review_status = 'approved'/);
    assert.match(queries[0], /primary_event\.pre_kill_switch_at is null/);
  } finally {
    neonConfig.fetchFunction = originalFetch;
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  }
});
