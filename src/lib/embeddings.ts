import { recordAiUsage } from "./aiUsage";

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
const CONCURRENCY = 8;

interface EmbedContentResponse {
  embedding?: { values?: number[] };
}

async function embedOne(text: string, apiKey: string): Promise<number[] | null> {
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
    return null;
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(`Embedding fetch failed: ${res.status} ${errBody.slice(0, 200)}`);
    return null;
  }

  const data = (await res.json()) as EmbedContentResponse;
  return data.embedding?.values ?? null;
}

// Returns one embedding per input text, in the SAME order, with `null` in
// place of any individual text that failed — unlike the old all-or-
// nothing batch call, a single bad item (rate limit, malformed text)
// shouldn't waste every other embedding in the same cycle. Returns null
// (not an array) only when nothing could even be attempted (no API key,
// empty input). Texts longer than ~2000 chars should be truncated by the
// caller before this — title+summary pairs never approach the model's
// real token limit, so no truncation happens here.
export async function embedBatch(texts: string[]): Promise<(number[] | null)[] | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || texts.length === 0) return null;

  const results: (number[] | null)[] = new Array(texts.length).fill(null);
  for (let start = 0; start < texts.length; start += CONCURRENCY) {
    const chunk = texts.slice(start, start + CONCURRENCY);
    const chunkResults = await Promise.all(chunk.map((t) => embedOne(t, apiKey)));
    chunkResults.forEach((r, i) => {
      results[start + i] = r;
    });
  }

  const succeeded = results.filter((r): r is number[] => r !== null).length;
  if (succeeded > 0) await recordAiUsage("embedding", succeeded);

  return results;
}
