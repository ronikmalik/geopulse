import { recordAiUsage } from "./aiUsage";

// Gemini embeddings, REST + simple API key — same shape as translate.ts's
// Google Cloud Translation integration (no OAuth/service account, no
// SDK). Soft no-op if GEMINI_API_KEY isn't set, same pattern as
// GOOGLE_TRANSLATE_API_KEY/FIRMS_MAP_KEY: ships now, activates the moment
// the key is added.
//
// Model id is configurable rather than hardcoded on purpose: Google's own
// docs disagreed with themselves on the exact current model string
// (gemini-embedding-001 vs gemini-embedding-2 vs gemini-embedding-2-
// preview) as of 2026-09-08, and this app's own knowledge of Gemini's
// current lineup is stale relative to today's date. gemini-embedding-001
// is the one name every source agreed actually exists, so it's the
// default — but if calls start failing with a 404-model-not-found, the
// fix is GEMINI_EMBED_MODEL in Vercel env vars, not a redeploy. GET
// /api/admin/ai-models calls Google's own ListModels endpoint (needs a
// real key configured) to confirm the authoritative current name rather
// than guessing again.
//
// output_dimensionality is requested explicitly at 768 regardless of
// which model ends up used — must match the vector(768) column in
// src/db/schema.ts; if the model or dimension ever changes, existing rows
// need re-embedding, not just new ones (a stored 768-dim vector isn't
// comparable to a differently-dimensioned one even if pgvector allowed
// the cast).
const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";
const EMBED_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents`;
const REQUEST_TIMEOUT_MS = 15_000;
const OUTPUT_DIMENSIONALITY = 768;

// Gemini's batchEmbedContents accepts up to 100 requests per call.
export const MAX_BATCH_SIZE = 100;

interface BatchEmbedResponse {
  embeddings?: { values?: number[] }[];
}

// Returns one embedding per input text, in order, or null for the whole
// batch on any failure (no API key, network error, non-200, malformed
// response) — callers fall back to "leave embedding null, retry next
// backfill cycle" rather than trying to salvage a partial result. Texts
// longer than ~2000 chars should be truncated by the caller before this —
// title+summary pairs from this app's sources never approach the model's
// real token limit, so no truncation happens here.
export async function embedBatch(texts: string[]): Promise<number[][] | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || texts.length === 0) return null;
  if (texts.length > MAX_BATCH_SIZE) {
    throw new Error(`embedBatch: ${texts.length} texts exceeds MAX_BATCH_SIZE (${MAX_BATCH_SIZE})`);
  }

  const body = {
    requests: texts.map((text) => ({
      model: `models/${EMBED_MODEL}`,
      content: { parts: [{ text }] },
      outputDimensionality: OUTPUT_DIMENSIONALITY,
    })),
  };

  let res: Response;
  try {
    res = await fetch(`${EMBED_ENDPOINT}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

  const data = (await res.json()) as BatchEmbedResponse;
  const embeddings = data.embeddings;
  if (!embeddings || embeddings.length !== texts.length) return null;
  if (embeddings.some((e) => !e.values)) return null;

  await recordAiUsage("embedding", texts.length);

  return embeddings.map((e) => e.values!);
}
