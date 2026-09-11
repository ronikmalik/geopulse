import { recordAiUsage, canAffordEmbeddingCalls } from "./aiUsage";

// Gemini embeddings, REST + simple API key — same shape as translate.ts's
// Google Cloud Translation integration (no OAuth/service account, no
// SDK). Soft no-op if GEMINI_API_KEY isn't set, same pattern as
// GOOGLE_TRANSLATE_API_KEY/FIRMS_MAP_KEY: ships now, activates the moment
// the key is added.
//
// Model id is configurable — see GET /api/admin/ai-models, which calls
// Google's own ListModels endpoint rather than trusting a guess. Verified
// live 2026-09-08 against a real key: gemini-embedding-001 exists and
// supports embedContent, but its ONLY batch-shaped method is
// asyncBatchEmbedContent (a submit-then-poll long-running job) — the
// synchronous :batchEmbedContents endpoint this file originally called
// does not exist for this model generation and was silently failing
// every call. Individual embedContent calls, issued concurrently, are
// the correct fix — see embedBatch below.
const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";
const EMBED_ENDPOINT_BASE = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}`;
const REQUEST_TIMEOUT_MS = 15_000;
const OUTPUT_DIMENSIONALITY = 768;

// Individual embedContent calls fired concurrently, not one big batch
// request (no synchronous batch endpoint exists — see the comment
// above). Caps concurrency so a large backfill run doesn't fire 100
// simultaneous requests at once; embeddingBackfill.ts's own per-cycle
// limit is separately sized to fit its time budget.
//
// Checked live against AI Studio's own Rate Limit dashboard (2026-09-08):
// the embedding model's free-tier cap is 100 RPM, and usage was sitting
// at exactly 100/100 — maxed, zero headroom, one concurrent caller
// elsewhere away from 429s. RPD headroom is huge (336/1000 used), so
// this wasn't a volume problem, just zero slack in the burst rate.
const CONCURRENCY = 4;

interface EmbedContentResponse {
  embedding?: { values?: number[] };
}

interface EmbedOneResult {
  vector: number[] | null;
  quotaExceeded: boolean;
}

async function embedOne(text: string, apiKey: string): Promise<EmbedOneResult> {
  let res: Response;
  try {
    res = await fetch(`${EMBED_ENDPOINT_BASE}:embedContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        outputDimensionality: OUTPUT_DIMENSIONALITY,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`Embedding request failed: ${err}`);
    return { vector: null, quotaExceeded: false };
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(`Embedding fetch failed: ${res.status} ${errBody.slice(0, 200)}`);
    return { vector: null, quotaExceeded: res.status === 429 };
  }

  const data = (await res.json()) as EmbedContentResponse;
  return { vector: data.embedding?.values ?? null, quotaExceeded: false };
}

// Returns one embedding per input text, in the SAME order, with `null` in
// place of any individual text that failed — unlike the old all-or-
// nothing batch call, a single bad item (rate limit, malformed text)
// shouldn't waste every other embedding in the same cycle. Returns null
// (not an array) only when nothing could even be attempted (no API key,
// empty input). Texts longer than ~2000 chars should be truncated by the
// caller before this — title+summary pairs never approach the model's
// real token limit, so no truncation happens here.
// Bounds the SUSTAINED rate, not just the burst — concurrency alone caps
// how many requests fire at once, but with no gap between chunks a large
// backlog run could still fire far more than 100 RPM in aggregate (24
// texts at CONCURRENCY=4 with embedContent's typical sub-second latency
// is 6 chunks in ~1-2s, nowhere near 60s). CONCURRENCY (4) per chunk,
// spaced to stay near ~80 RPM (real margin under the 100 RPM ceiling
// confirmed live via AI Studio's Rate Limit dashboard, 2026-09-08) needs
// at most 20 chunks/minute — 60s / 20 = 3s between chunks.
const CHUNK_SPACING_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function embedBatch(texts: string[]): Promise<(number[] | null)[] | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || texts.length === 0) return null;

  // Paced courtesy check (2026-09-11, live-caught) — see aiUsage.ts's
  // EMBEDDING_DAILY_CAP/getEmbeddingBudget doc comment for the incident
  // this fixes: with no cap at all, a real production day spent its whole
  // RPD budget by mid-morning Pacific and then 429ed on every attempt for
  // the rest of the day. Checked once per embedBatch call (both current
  // callers pass a small fixed-size chunk — see BACKFILL_BATCH_SIZE in
  // embeddingBackfill.ts/classificationArchiveEmbeddingBackfill.ts — so one
  // check per call already means one check per chunk in practice) rather
  // than mid-loop, same "ask before spending, not after" posture as the
  // quota-exceeded circuit breaker below. Returns null (not an array of
  // nulls) — "nothing could even be attempted this cycle" is exactly what
  // this is, the same meaning null already has for no-API-key/empty-input
  // above, and every existing caller already treats null as "skipped, try
  // again next cycle."
  if (!(await canAffordEmbeddingCalls(texts.length))) return null;

  const results: (number[] | null)[] = new Array(texts.length).fill(null);
  for (let start = 0; start < texts.length; start += CONCURRENCY) {
    if (start > 0) await sleep(CHUNK_SPACING_MS);
    const chunk = texts.slice(start, start + CONCURRENCY);
    const chunkResults = await Promise.all(chunk.map((t) => embedOne(t, apiKey)));
    let quotaExceeded = false;
    chunkResults.forEach((r, i) => {
      results[start + i] = r.vector;
      if (r.quotaExceeded) quotaExceeded = true;
    });
    // Circuit breaker (2026-09-10, live-caught): a real production window
    // showed EVERY embedContent call in a cycle 429ing with "You exceeded
    // your current quota" (a hard RPD cap, not the RPM burst CHUNK_SPACING_MS
    // already paces around — confirmed distinct because the failures were
    // sustained across many consecutive calls and cycles, not intermittent).
    // Once one call in a chunk reports quota exhaustion, every remaining
    // call this invocation is going to fail the exact same way — stop
    // immediately instead of paying CHUNK_SPACING_MS + a doomed request per
    // remaining chunk. This doesn't affect credibility (embeddings don't
    // gate what publishes, only similarity/clustering features not yet
    // user-facing), so shedding load here is free — the whole point is to
    // leave the wall-clock and RPD/RPM budget for callers that DO gate
    // credibility (reviewPendingEvents/classifierAuditSlice).
    if (quotaExceeded) break;
  }

  const succeeded = results.filter((r): r is number[] => r !== null).length;
  if (succeeded > 0) await recordAiUsage("embedding", succeeded);

  return results;
}
