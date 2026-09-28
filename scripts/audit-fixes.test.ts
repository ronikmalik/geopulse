import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { neonConfig } from "@neondatabase/serverless";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import { NextRequest } from "next/server";
import * as schema from "../src/db/schema";
import { getDb } from "../src/db";
import { getSimilarEvents } from "../src/lib/similarEvents";
import { fetchRecentPrimaries, promoteDuplicateAfterRejection } from "../src/lib/eventDedup";
import { runStoryDedupPass } from "../src/lib/storyDedup";
import { insertDirectItems } from "../src/lib/ingest";
import { reviewPendingEvents } from "../src/lib/classifierAudit";
import { retryFailedClassificationsViaTranslation } from "../src/lib/classifyTranslated";
import { runAnomalyScan } from "../src/lib/anomalyScan";
import { runAlertEvaluation } from "../src/lib/alertEngine";
import { snapshotAircraftCounts, snapshotCommercialAircraftCounts } from "../src/lib/flightBaseline";
import { drainPendingGdeltTitles } from "../src/lib/sources/gdeltBulk";
import { markPendingGdeltTitlesResolved } from "../src/lib/pendingGdeltTitle";
import { GET as getAnomalies } from "../src/app/api/anomalies/route";
import { GET as getHealth } from "../src/app/api/admin/health/route";
import { GET as getModels } from "../src/app/api/admin/ai-models/route";
import { applyTsunamiBulletins } from "../src/lib/tsunamiEnrichment";
import type { TsunamiBulletin } from "../src/lib/sources/tsunami";

// 2026-09-28: run production queries in memory; no provider or database traffic can escape.
async function fixture(t: TestContext) {
  const pg = new PGlite();
  const savedEnv = { ...process.env };
  process.env.DATABASE_URL = "postgresql://test:test@example.invalid/test";
  process.env.CRON_SECRET = "test-only";
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_TRANSLATE_API_KEY;
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  const dialect = new PgDialect();
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  for (const table of Object.values(schema)) {
    if (!is(table, PgTable)) continue;
    const config = getTableConfig(table);
    const columns = config.columns.map((c) => {
      let result = `${quote(c.name)} ${c.getSQLType().replace(/(?:halfvec|vector)\(\d+\)/g, "text")}`;
      if (c.primary) result += " primary key";
      if (c.isUnique) result += " unique";
      if (c.notNull) result += " not null";
      if (c.default !== undefined) {
        const value = is(c.default, SQL) ? dialect.sqlToQuery(c.default).sql :
          typeof c.default === "string" ? `'${c.default.replaceAll("'", "''")}'` : String(c.default);
        result += ` default ${value}`;
      }
      return result;
    });
    for (const key of config.primaryKeys) columns.push(`primary key (${key.columns.map((c) => quote(c.name)).join(",")})`);
    for (const key of config.uniqueConstraints) columns.push(`unique (${key.columns.map((c) => quote(c.name)).join(",")})`);
    await pg.exec(`create table ${quote(config.name)} (${columns.join(",")})`);
  }
  // 2026-09-28: only vector distance is substituted; visibility SQL and batch boundaries run unchanged.
  await pg.exec(`create domain halfvec as text;
    create function test_distance(text, text) returns double precision language sql immutable
    as 'select abs(($1::json->>0)::float8 - ($2::json->>0)::float8)';
    create operator <=> (leftarg = text, rightarg = text, function = test_distance);`);
  const queries: string[] = [];
  let fail: (query: string) => boolean = () => false;
  const execute = async (q: { query: string; params: unknown[] }) => {
    queries.push(q.query);
    if (fail(q.query)) throw new Error("injected persistence failure");
    const result = await pg.query(q.query, q.params, { rowMode: "array" });
    return { ...result, rowCount: result.rows.length, command: "SELECT" };
  };
  // Assigned, not t.mock.method: fetchFunction is undefined until set.
  const savedNeonFetch = neonConfig.fetchFunction;
  neonConfig.fetchFunction = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (!body.queries) return Response.json(await execute(body));
    await pg.exec("begin");
    try {
      const results = [];
      for (const query of body.queries) results.push(await execute(query));
      await pg.exec("commit");
      return Response.json({ results });
    } catch (error) {
      await pg.exec("rollback");
      throw error;
    }
  };
  t.after(async () => { neonConfig.fetchFunction = savedNeonFetch; process.env = savedEnv; await pg.close(); });
  async function event(id: number, overrides: Partial<typeof schema.events.$inferInsert> = {}) {
    await getDb().insert(schema.events).values({
      id, source: `rss:outlet-${id}`, url: `https://example.invalid/${id}`,
      title: "Ukraine missile strike destroys ammunition depot", summary: "Ukraine missile strike destroys ammunition depot",
      country: "UA", category: "russia-ukraine", location: "Ukraine", lat: 49, lon: 32,
      severity: 4, publishedAt: new Date(), reviewStatus: "approved", ...overrides,
    });
  }
  return { pg, event, queries, failWhen: (fn: typeof fail) => { fail = fn; } };
}

const admin = () => new NextRequest("https://example.invalid/api/admin/test", { headers: { authorization: "Bearer test-only" } });
const gemini = (items: unknown[]) => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(items) }] } }] });

test("related events exclude withheld seeds and archive matches but retain aged-out stories", async (t) => {
  const { pg, event, queries } = await fixture(t);
  await event(1);
  await event(2, { reviewStatus: "pending" });
  await event(3, { reviewStatus: "rejected" });
  await event(4, { preKillSwitchAt: new Date() });
  await event(5);
  for (let id = 1; id <= 6; id++) {
    await pg.query(`insert into feed_archive(source,url,title,summary,country,category,lat,lon,severity,published_at,embedding)
      values($1,$2,$3,'summary','UA','russia-ukraine',49,32,4,now(),$4)`,
    [`rss:outlet-${id}`, `https://example.invalid/${id}`, `Story ${id}`, `[${id / 100}]`]);
  }
  for (const id of [2, 3, 4]) assert.deepEqual(await getSimilarEvents(id), []);
  assert.deepEqual((await getSimilarEvents(1)).map((r) => r.title), ["Story 5", "Story 6"]);
  assert.ok(queries.includes("set local hnsw.iterative_scan = relaxed_order"));
  await pg.exec("update events set source = 'usgs' where id in (1,2)");
  assert.deepEqual(await getSimilarEvents(2), []);
  assert.ok((await getSimilarEvents(1)).every((r) => r.id === 5));
});

test("rejected primaries are excluded and surviving duplicates are promoted in publication order", async (t) => {
  const { pg, event } = await fixture(t);
  await event(1, { reviewStatus: "rejected" });
  await event(2, { primaryEventId: 1, reviewStatus: "rejected" });
  await event(3, { primaryEventId: 1, preKillSwitchAt: new Date() });
  await event(4, { primaryEventId: 1, publishedAt: new Date(Date.now() - 60_000) });
  await event(5, { primaryEventId: 1, reviewStatus: "pending" });
  assert.deepEqual(await fetchRecentPrimaries("UA", "russia-ukraine", new Date()), []);
  await promoteDuplicateAfterRejection(1);
  const rows = (await pg.query<{ id: number; primary_event_id: number | null }>("select id, primary_event_id from events order by id")).rows;
  assert.deepEqual(rows.map((r) => r.primary_event_id), [null, 4, 4, null, 4]);
  assert.deepEqual((await fetchRecentPrimaries("UA", "russia-ukraine", new Date())).map((r) => r.id), [4]);
  await promoteDuplicateAfterRejection(1);
  assert.equal((await pg.query("select id from events where primary_event_id = 1")).rows.length, 0);
});

test("both pending-review rejection paths release surviving duplicate clusters", async (t) => {
  const { pg, event } = await fixture(t);
  process.env.GEMINI_API_KEY = "test-only";
  await event(1, { reviewStatus: "pending", reviewAttempts: 2 });
  await event(2, { primaryEventId: 1 });
  await event(3, { reviewStatus: "pending" });
  await event(4, { primaryEventId: 3 });
  t.mock.method(globalThis, "fetch", async () => gemini([
    { id: 1 }, { id: 3, validInclusion: false, country: "UA", severity: 4, reasoning: "Not a new incident" },
  ]));
  const result = await reviewPendingEvents();
  assert.equal(result.withheld, 1);
  assert.equal(result.rejected, 1);
  assert.equal((await pg.query("select id from events where id in (2,4) and primary_event_id is null")).rows.length, 2);
});

test("story dedup rechecks a target rejected while the model was running", async (t) => {
  const { pg, event } = await fixture(t);
  await event(1);
  await event(2);
  t.mock.method(globalThis, "fetch", async () => {
    await pg.exec("update events set review_status = 'rejected' where id = 1");
    return gemini([{ id: 2, duplicateOfId: 1, reasoning: "Same incident" }]);
  });
  const result = await runStoryDedupPass([{ id: 2, title: "Fixture", snippet: "Fixture", country: "UA", category: "russia-ukraine", publishedAt: new Date() }], "test-only");
  assert.equal(result.merged, 0);
  assert.equal((await pg.query<{ primary_event_id: number | null }>("select primary_event_id from events where id = 2")).rows[0].primary_event_id, null);
});

test("direct Telegram items remain pending until review or the 30-minute fallback", async (t) => {
  const { pg } = await fixture(t);
  const sources = ["telegram:fixture", "usgs", "eonet", "gdacs", "ioda", "firms"];
  const result = await insertDirectItems(sources.map((source) => ({
    source, url: `https://example.invalid/${source}`, title: "Fixture", summary: "Fixture",
    category: "natural-disaster", country: "UA", location: "Ukraine", lat: 49, lon: 32,
    severity: 4, publishedAt: new Date(),
  })));
  assert.equal(result.error, null);
  assert.equal(result.inserted, 6);
  assert.equal((await pg.query<{ n: number }>("select count(*)::int as n from events where review_status = 'approved'")).rows[0].n, 5);
  assert.equal((await reviewPendingEvents()).autoPromoted, 0);
  await pg.exec("update events set created_at = now() - interval '31 minutes' where source like 'telegram:%'");
  assert.equal((await reviewPendingEvents()).autoPromoted, 1);
  await pg.exec("update events set review_status = 'pending', created_at = now() where source like 'telegram:%'");
  process.env.GEMINI_API_KEY = "test-only";
  const id = (await pg.query<{ id: number }>("select id from events where source like 'telegram:%'")).rows[0].id;
  t.mock.method(globalThis, "fetch", async () => gemini([{ id, validInclusion: false, country: "UA", severity: 4, reasoning: "Outside scope" }]));
  assert.equal((await reviewPendingEvents()).rejected, 1);
});

test("translated retry preserves strict GDELT credibility and severity eligibility", async (t) => {
  await fixture(t);
  process.env.GOOGLE_TRANSLATE_API_KEY = "test-only";
  t.mock.method(getDb(), "execute", async () => ({ rows: [{ characters: 1 }] }));
  const original = { source: "gdelt", title: "Ukraine meldet Vorfall", snippet: "Ukraine", publishedAt: new Date(), url: "https://rated.example/story" };
  const translated = "Ukraine missile strike kills 10 soldiers and destroys ammunition depot";
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: { translations: [{ translatedText: translated }, { translatedText: translated }] } }));
  const good = { domain: "rated.example", bias: "Least Biased", factualRating: "High", credibility: "High" };
  for (const map of [new Map(), new Map([[good.domain, { ...good, credibility: "Low" }]])]) {
    assert.equal((await retryFailedClassificationsViaTranslation([original], map)).recovered.length, 0);
  }
  assert.equal((await retryFailedClassificationsViaTranslation([original], new Map([[good.domain, good]]))).recovered.length, 1);
  assert.equal((await retryFailedClassificationsViaTranslation([{ ...original, source: "rss:fixture" }], new Map())).recovered.length, 1);
  assert.equal((await retryFailedClassificationsViaTranslation([original], undefined)).recovered.length, 1);
});

test("successful empty anomaly scans supersede findings; failed scans preserve the last generation", async (t) => {
  const { pg, failWhen } = await fixture(t);
  await pg.exec(`insert into anomaly_findings(detected_at,signal_type,country,observed_value,baseline_mean,baseline_std_dev,sample_size,jump,z_score)
    values(now() - interval '1 hour','aircraft-commercial','UA',0,100,5,20,-100,-20)`);
  assert.equal((await (await getAnomalies()).json()).findings.length, 1);
  failWhen((q) => q.includes('from "aircraft_count_history"'));
  const failed = await runAnomalyScan();
  assert.ok(failed.errors.length > 0);
  assert.equal((await (await getAnomalies()).json()).findings.length, 1);
  failWhen(() => false);
  const empty = await runAnomalyScan();
  assert.deepEqual(empty.errors, []);
  assert.equal(empty.findingsInserted, 0);
  const response = await (await getAnomalies()).json();
  assert.deepEqual(response.findings, []);
  assert.equal(+new Date(response.detectedAt), +new Date(empty.detectedAt));
  assert.equal((await runAlertEvaluation()).errors.length, 0);
  assert.equal((await pg.query<{ anomaly_signals: number }>("select anomaly_signals from alert_country_state where country = 'UA'")).rows[0].anomaly_signals, 0);
});

test("alert persistence failures preserve retry state and duplicates add only corroboration", async (t) => {
  const { pg, event, failWhen } = await fixture(t);
  await event(1);
  await event(2, { primaryEventId: 1, severity: 5 });
  await event(3, { primaryEventId: 1 });
  await event(4, { primaryEventId: 1, reviewStatus: "pending" });
  await event(5, { primaryEventId: 1, reviewStatus: "rejected" });
  await event(6, { primaryEventId: 1, preKillSwitchAt: new Date() });
  await event(7, { reviewStatus: "rejected" });
  await event(8, { primaryEventId: 7 });
  await pg.exec("insert into alert_country_state(country,level,momentum,anomaly_signals) values('UA',0,0,0)");
  failWhen((q) => q.startsWith('insert into "alerts"'));
  const failed = await runAlertEvaluation();
  assert.ok(failed.errors.some((e) => e.startsWith("insert:")));
  assert.equal(failed.fired, 0);
  assert.deepEqual(failed.byTier, {});
  assert.equal((await pg.query<{ level: number }>("select level from alert_country_state where country = 'UA'")).rows[0].level, 0);
  failWhen(() => false);
  const success = await runAlertEvaluation();
  assert.deepEqual(success.errors, []);
  assert.equal(success.fired, 1);
  const alert = (await pg.query<{ source_families: number; max_severity: number; evidence: string }>("select * from alerts where country = 'UA'")).rows[0];
  assert.equal(alert.source_families, 3);
  assert.equal(alert.max_severity, 4);
  assert.deepEqual(JSON.parse(alert.evidence).map((e: { id: number }) => e.id), [1]);
});

test("health detects stopped scheduling and respects daily anomaly cadence", async (t) => {
  const { pg } = await fixture(t);
  await pg.exec(`insert into source_health(source,last_attempt_at,last_success_at) values
    ('rss',now()-interval '3 hours',now()-interval '3 hours'),
    ('usgs',now()-interval '15 minutes',now()-interval '15 minutes'),
    ('never',now(),null),('anomaly-scan',now()-interval '25 hours',now()-interval '25 hours')`);
  const data = await (await getHealth(admin())).json();
  const statuses = Object.fromEntries(data.sources.map((r: { source: string; status: string }) => [r.source, r.status]));
  assert.deepEqual(statuses, { rss: "stale", usgs: "ok", never: "never_succeeded", "anomaly-scan": "ok" });
  await pg.exec("update source_health set last_attempt_at = now()-interval '49 hours',last_success_at = now()-interval '49 hours' where source = 'anomaly-scan'");
  assert.equal((await (await getHealth(admin())).json()).sources.find((r: { source: string }) => r.source === "anomaly-scan").status, "stale");
});

test("model discovery bounds fetch and body failures with a deadline", async (t) => {
  await fixture(t);
  process.env.GEMINI_API_KEY = "test-only";
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => { deadlines.push(ms); return new AbortController().signal; });
  for (const mode of ["fetch", "body", "ok"] as const) {
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      assert.ok(init?.signal);
      if (mode === "fetch") throw new Error("request failed");
      if (mode === "body") return new Response("invalid json");
      return Response.json({ models: [{ name: "test", supportedGenerationMethods: ["generateContent"] }] });
    });
    const response = await getModels(admin());
    assert.equal(response.status, mode === "ok" ? 200 : 502);
    if (mode !== "ok") assert.deepEqual(await response.json(), { error: "Model discovery failed or timed out" });
  }
  assert.deepEqual(deadlines, [10_000, 10_000, 10_000]);
});

test("GDELT titles stay queued until an insert or recorded rejection succeeds", async (t) => {
  const { pg, event } = await fixture(t);
  await pg.exec(`insert into pending_gdelt_title(url,resolved_country,published_at) values('https://example.invalid/1','UA',now())`);
  t.mock.method(globalThis, "fetch", async () => new Response('<html><head><title>Ukraine missile strike destroys ammunition depot</title></head></html>', { headers: { 'content-type': 'text/html' } }));
  const items = await drainPendingGdeltTitles();
  assert.equal(items.length, 1);
  const urls = items.map((i) => i.url);
  const resolved = async () => (await pg.query<{ resolved_at: Date | null }>("select resolved_at from pending_gdelt_title")).rows[0].resolved_at;
  assert.equal(await resolved(), null);
  await markPendingGdeltTitlesResolved(urls);
  assert.equal(await resolved(), null);
  await event(1);
  await markPendingGdeltTitlesResolved(urls);
  assert.ok(await resolved());
  await pg.exec("delete from events; update pending_gdelt_title set resolved_at = null");
  await getDb().insert(schema.classificationArchive).values({ source: "gdelt", url: urls[0], title: "Fixture", snippet: "Fixture", kept: false, severity: 1, publishedAt: new Date() });
  await markPendingGdeltTitlesResolved(urls);
  assert.ok(await resolved());
  await pg.exec("delete from classification_archive; update pending_gdelt_title set resolved_at = null");
  await markPendingGdeltTitlesResolved(urls, urls);
  assert.ok(await resolved());
});

test("aircraft snapshots record a regular country's complete drop, but not glitches or sparse countries", async (t) => {
  const { pg } = await fixture(t);
  // UA and GB were seen on each of the last 8 days; PL only once.
  for (let d = 1; d <= 8; d++) {
    await pg.exec(`insert into aircraft_count_history(country,kind,count,snapshot_at) values
      ('UA','military',10,now()-interval '${d} days'),('GB','commercial',100,now()-interval '${d} days')`);
  }
  await pg.exec("insert into aircraft_count_history(country,kind,count,snapshot_at) values('PL','military',1,now()-interval '3 days')");
  const latest = async (country: string, kind: string) =>
    (await pg.query<{ count: number }>(`select count from aircraft_count_history where country='${country}' and kind='${kind}' order by id desc limit 1`)).rows[0]?.count;

  // A complete collection that saw one aircraft over France only.
  t.mock.method(globalThis, "fetch", async () => Response.json({ ac: [{ hex: "abc123", lat: 48.85, lon: 2.35 }] }));
  assert.deepEqual(await snapshotAircraftCounts(), { inserted: 2, countriesSeen: 1 });
  assert.equal(await latest("UA", "military"), 0);
  assert.equal(await latest("PL", "military"), 1, "a sparse country is not zero-filled");
  assert.deepEqual(await snapshotCommercialAircraftCounts(), { inserted: 2, countriesSeen: 1 });
  assert.equal(await latest("GB", "commercial"), 0);

  // An empty response is treated as a glitch: nothing is written.
  const before = (await pg.query<{ n: number }>("select count(*)::int as n from aircraft_count_history")).rows[0].n;
  t.mock.method(globalThis, "fetch", async () => Response.json({ ac: [] }));
  assert.deepEqual(await snapshotAircraftCounts(), { inserted: 0, countriesSeen: 0 });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  await assert.rejects(snapshotAircraftCounts());
  assert.equal((await pg.query<{ n: number }>("select count(*)::int as n from aircraft_count_history")).rows[0].n, before);
});

test("NOAA tsunami bulletins annotate the matching quake in events and feed_archive, idempotently", async (t) => {
  const { pg, event } = await fixture(t);
  const issuedAt = new Date(Date.now() - 30 * 60_000);
  const base = "Magnitude 5.4 earthquake 231 km WSW of Port McNeill, Canada.";
  await event(1, {
    source: "usgs", url: "https://example.invalid/q1", title: "M 5.4", summary: base, category: "earthquake",
    country: "CA", lat: 50.4, lon: -129.2, severity: 2, publishedAt: new Date(issuedAt.getTime() - 15 * 60_000),
  });
  await event(2, {
    source: "usgs", url: "https://example.invalid/q2", title: "M 4.8", summary: "Magnitude 4.8 earthquake far away.",
    category: "earthquake", country: "JP", lat: 35, lon: 140, severity: 1, publishedAt: new Date(issuedAt.getTime() - 10 * 60_000),
  });
  await pg.exec(`insert into feed_archive(source,url,title,summary,category,lat,lon,severity,published_at)
    values('usgs','https://example.invalid/q1','M 5.4','${base}','earthquake',50.4,-129.2,2,now())`);
  const bulletin: TsunamiBulletin = {
    center: "NTWC", category: "Information", issuedAt, lat: 50.327, lon: -129.358, magnitude: 5,
    region: "95 miles W of Port Alice, British Columbia", note: "* There is NO tsunami danger from this earthquake.",
  };
  assert.deepEqual(await applyTsunamiBulletins(async () => [bulletin]), { bulletins: 1, matched: 1, updated: 1 });
  assert.deepEqual(await applyTsunamiBulletins(async () => [bulletin]), { bulletins: 1, matched: 1, updated: 0 });
  const rows = (await pg.query<{ id: number; summary: string }>("select id, summary from events order by id")).rows;
  assert.equal(rows[0].summary, `${base} Tsunami status (NOAA NTWC): information bulletin - "There is NO tsunami danger from this earthquake."`);
  assert.equal(rows[1].summary, "Magnitude 4.8 earthquake far away.");
  const archived = (await pg.query<{ summary: string }>("select summary from feed_archive")).rows[0].summary;
  assert.equal(archived, rows[0].summary);
  // Old bulletins are ignored outright.
  const stale = { ...bulletin, issuedAt: new Date(Date.now() - 3 * 86_400_000) };
  assert.deepEqual(await applyTsunamiBulletins(async () => [stale]), { bulletins: 0, matched: 0, updated: 0 });
});
