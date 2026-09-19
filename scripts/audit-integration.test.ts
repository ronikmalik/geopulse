import assert from "node:assert/strict";
import { test } from "node:test";
import { neonConfig } from "@neondatabase/serverless";
import { reviewPendingEvents } from "../src/lib/classifierAudit";

test("pending review rejects malformed responses and cannot overwrite a concurrently resolved item", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  const originalNeon = neonConfig.fetchFunction;
  const originalError = console.error;
  process.env.DATABASE_URL = "postgresql://test:test@example.invalid/test";
  process.env.GEMINI_API_KEY = "test-only";
  try {
    for (const scenario of ["malformed", "lost-race", "approved"] as const) {
      const errors: unknown[][] = [];
      console.error = (...args) => { errors.push(args); };
      const updates: { query: string; params: unknown[] }[] = [];
      neonConfig.fetchFunction = async (_url: unknown, init?: RequestInit) => {
        const query = JSON.parse(String(init?.body));
        let rows: unknown[][] = [];
        if (query.query.includes('from "events"') && query.query.includes('"country" is not null')) {
          rows = [[1, "rss:fixture", "https://example.invalid/story", "2026-09-12T12:00:00Z", "Fixture incident", "Fixture incident", 3, "UA", "russia-ukraine"]];
        }
        if (query.query.startsWith('update "events"') && query.query.includes('"events"."id" =')) {
          updates.push(query);
          rows = scenario === "approved" ? [[1]] : [];
        }
        return Response.json({ fields: (rows[0] ?? []).map((_, index) => ({ name: String(index), dataTypeID: index === 0 || index === 6 ? 23 : 25 })), rows, rowCount: rows.length, command: "SELECT" });
      };
      globalThis.fetch = async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(scenario === "malformed" ? [{ id: 1 }] : [{ id: 1, validInclusion: true, country: "UA", severity: 3, reasoning: "" }]) }] } }] });
      const result = await reviewPendingEvents();
      assert.deepEqual(errors, [], `${scenario} emitted an unexpected error`);
      assert.equal(result.approved, scenario === "approved" ? 1 : 0);
      assert.equal(result.rejected, 0);
      assert.equal(updates.length, scenario === "malformed" ? 0 : 1, scenario);
      for (const update of updates) {
        assert.match(update.query, /where \("events"\."id" = .* and "events"\."review_status" =/);
        assert.ok(update.params.includes("pending"));
      }
    }
  } finally {
    process.env = saved;
    globalThis.fetch = originalFetch;
    neonConfig.fetchFunction = originalNeon;
    console.error = originalError;
  }
});
