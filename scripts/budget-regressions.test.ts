import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { neonConfig } from "@neondatabase/serverless";
import { reserveAiCalls, canAffordGeminiLiteCall, getEmbeddingBudget } from "../src/lib/aiUsage";
import { reserveTranslationBytes, translationMonthReady } from "../src/lib/translationUsage";
import { generateContent, resetModelCooldowns } from "../src/lib/geminiGenerate";
import { embedBatch } from "../src/lib/embeddings";

// Run production SQL through a real, isolated PostgreSQL engine in memory.
// No credentials, provider calls, Neon wake-ups or persistent test tables.
test("budget reservations enforce caps across overlapping callers and upstream failures", async (t) => {
  const pg = new PGlite();
  await pg.exec(`
    create table ai_usage (date text, kind text, count integer not null, primary key(date, kind));
    create table translation_usage (date text primary key, characters integer not null);
  `);
  const savedEnv = { ...process.env };
  const savedNeon = neonConfig.fetchFunction;
  process.env.DATABASE_URL = "postgresql://test:test@example.invalid/test";
  process.env.GEMINI_API_KEY = "test-only";
  neonConfig.fetchFunction = async (_url: unknown, init?: RequestInit) => {
    const { query, params } = JSON.parse(String(init?.body));
    const result = await pg.query(query, params, { rowMode: "array" });
    return Response.json({ ...result, rowCount: result.rows.length, command: "SELECT" });
  };
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  try {
    await t.test("one remaining AI slot cannot be granted to two callers", async () => {
      await pg.exec(`insert into ai_usage values (to_char(now() at time zone 'America/Los_Angeles', 'YYYY-MM-DD'), 'audit', 269)`);
      const grants = await Promise.all(Array.from({ length: 12 }, () => reserveAiCalls("audit", 1)));
      assert.equal(grants.filter(Boolean).length, 1);
      assert.equal((await pg.query<{ count: number }>("select count from ai_usage where kind = 'audit'")).rows[0].count, 270);
      for (const invalid of [0, -1, 1.5, NaN, Infinity, 271]) assert.equal(await reserveAiCalls("audit", invalid), false);
    });
    await t.test("each failed primary and fallback reserves; cap stops the chain before HTTP", async (s) => {
      resetModelCooldowns();
      await pg.exec("update ai_usage set count = 268 where kind = 'audit'");
      const upstream = s.mock.method(globalThis, "fetch", async () => new Response("busy", { status: 503 }));
      const outcome = await generateContent("gemini-3.5-flash-lite", {}, "test", 1000, "audit");
      assert.equal(outcome.ok, false);
      assert.equal(upstream.mock.callCount(), 2);
      assert.equal((await pg.query<{ count: number }>("select count from ai_usage where kind = 'audit'")).rows[0].count, 270);
    });
    await t.test("failed embedding attempts remain charged and keys stay out of URLs", async (s) => {
      const upstream = s.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        assert.ok(!url.includes("key="));
        assert.equal((init.headers as Record<string, string>)["x-goog-api-key"], "test-only");
        throw new Error("timeout after upstream accepted the request");
      });
      assert.deepEqual(await embedBatch(["one", "two"]), [null, null]);
      assert.equal(upstream.mock.callCount(), 2);
      assert.equal((await pg.query<{ count: number }>("select count from ai_usage where kind = 'embedding'")).rows[0].count, 2);
    });
    await t.test("translation stale reads cannot reserve the same remaining bytes twice", async () => {
      // Today has 100 bytes left in the MONTH, and ample daily allowance.
      // Freeze only JS time to a late-month fixture and substitute that
      // date in PostgreSQL's clock expression at the transport boundary.
      const realDate = new Date("2026-09-24T23:00:00Z");
      t.mock.timers.enable({ apis: ["Date"], now: realDate });
      await pg.exec("insert into translation_usage values ('2026-09-23', 480000), ('2026-09-24', 9900)");
      neonConfig.fetchFunction = async (_url: unknown, init?: RequestInit) => {
        const { query, params } = JSON.parse(String(init?.body));
        const fixed = query.replaceAll("clock_timestamp()", "timestamptz '2026-09-24T23:00:00Z'");
        const result = await pg.query(fixed, params, { rowMode: "array" });
        return Response.json({ ...result, rowCount: result.rows.length, command: "SELECT" });
      };
      // This fixture is already beyond its daily pace; all attempts must
      // decline even though there is a little monthly room.
      assert.equal(await reserveTranslationBytes(1), false);
      await pg.exec("update translation_usage set characters = 0 where date = '2026-09-24'");
      const grants = await Promise.all(Array.from({ length: 12 }, () => reserveTranslationBytes(100)));
      assert.equal(grants.filter(Boolean).length, 1);
      const used = (await pg.query<{ characters: number }>("select characters from translation_usage where date = '2026-09-24'")).rows[0].characters;
      assert.equal(used, grants.filter(Boolean).length * 100);
      assert.ok(used <= Math.floor((10000 / 7) * (23 / 24)));
      // Force a near-monthly-cap daily row, with the same guard rejecting it.
      await pg.exec("update translation_usage set characters = 10000 where date = '2026-09-24'");
      assert.equal(await reserveTranslationBytes(1), false);
      t.mock.timers.reset();
    });
    await t.test("a broken ledger blocks AI and embeddings instead of granting an empty budget", async (s) => {
      neonConfig.fetchFunction = async () => { throw new Error("DB unavailable"); };
      resetModelCooldowns();
      const upstream = s.mock.method(globalThis, "fetch", async () => { throw new Error("must not call upstream"); });
      assert.equal(await reserveAiCalls("brief", 1), false);
      assert.equal(await canAffordGeminiLiteCall("brief"), false);
      assert.equal((await getEmbeddingBudget()).remainingToday, 0);
      assert.equal(await reserveTranslationBytes(1), false);
      assert.equal((await generateContent("gemini-3.5-flash-lite", {}, "test", 1000, "brief")).ok, false);
      assert.equal(upstream.mock.callCount(), 0);
    });
  } finally {
    process.env = savedEnv;
    neonConfig.fetchFunction = savedNeon;
    resetModelCooldowns();
    await pg.close();
  }
});

test("translation cannot spend next month's allowance before Pacific midnight", () => {
  for (const month of ["2026-10", "2026-12"]) {
    assert.equal(translationMonthReady(new Date(`${month}-01T00:00:00Z`)), false);
    assert.equal(translationMonthReady(new Date(`${month}-01T07:59:59Z`)), false);
    assert.equal(translationMonthReady(new Date(`${month}-01T08:00:00Z`)), true);
    assert.equal(translationMonthReady(new Date(`${month}-02T00:00:00Z`)), true);
  }
});
