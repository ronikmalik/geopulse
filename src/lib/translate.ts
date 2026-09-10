import { canAfford, recordUsage } from "./translationUsage";

// Google's own Cloud Translation - Basic pricing table lists the rate as
// "$20.00 / 1,000,000 byte" (checked live 2026-09-10) — despite the same
// page's general "Charged characters" section saying billing is per
// character/code point elsewhere, the price table itself says byte for
// this specific tier. Counting UTF-8 bytes here is the conservative
// reading either way: bytes >= characters for any text, so this can only
// under-estimate headroom, never over-estimate it. Matters concretely for
// this app specifically — most translated text is Ukrainian/Russian/Farsi/
// Arabic (Telegram sources), which run 2 bytes/char in UTF-8 versus 1 for
// ASCII, so a character-counting cap could meaningfully understate real
// usage against Google's own meter for exactly the content this app
// translates the most of.
// Exported so telegram.ts can cap its excerpt at a real byte budget before
// translating, rather than a character count that understates true cost
// for exactly the non-Latin scripts this app translates most of (see this
// function's own comment above).
export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

// Google Cloud Translation API v2 ("Basic"), REST + simple API key — no
// OAuth/service account needed. Verified against Google's own current
// docs before implementing (POST, form-encoded body, `q` repeatable for
// batch translation in one request). Soft no-op if GOOGLE_TRANSLATE_API_KEY
// isn't set, same pattern as FIRMS_MAP_KEY: the feature ships now and
// activates the moment the key is added, no code change needed.
const TRANSLATE_ENDPOINT = "https://translation.googleapis.com/language/translate/v2";
const REQUEST_TIMEOUT_MS = 10_000;

interface TranslateApiResponse {
  data?: {
    translations?: { translatedText: string; detectedSourceLanguage?: string }[];
  };
}

// Batches every text in one request (Google's v2 API accepts a repeated
// `q` param, up to 128 strings) rather than one call per post — cheaper,
// faster, and keeps this well inside the per-ingest-cycle time budget the
// same way the GDELT/Telegram rotation does. Returns null (not a partial
// result) on any failure so callers fall back to the original text rather
// than silently mixing translated and untranslated items from one batch.
//
// sourceLang "auto" (added 2026-09-10 for classifyTranslated.ts — see its
// own doc comment) omits the `source` field entirely, which is Google's
// own documented way to request language auto-detection: unlike Telegram
// channels (each pre-tagged with a known language in telegram.ts's own
// config), RSS/GDELT items arrive in unpredictable languages with no
// prior tag to pass in. If the detected language is already English, the
// "translation" comes back as the original text — a harmless no-op for
// callers, not a special case they need to detect separately.
export async function translateBatch(
  texts: string[],
  sourceLang: string | "auto",
): Promise<string[] | null> {
  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!apiKey || texts.length === 0) return null;

  // Hard cap, checked before every call: 499,000 BYTES/month (see
  // byteLength's own comment for why bytes, not JS string length),
  // portioned out across the day rather than front-loaded — see
  // src/lib/translationUsage.ts. A DB read failing here fails safe (skip
  // translation, not skip the check) since the whole point is never
  // risking an overage.
  const estimatedBytes = texts.reduce((sum, t) => sum + byteLength(t), 0);
  const affordable = await canAfford(estimatedBytes).catch(() => false);
  if (!affordable) return null;

  const body = new URLSearchParams();
  for (const text of texts) body.append("q", text);
  if (sourceLang !== "auto") body.set("source", sourceLang);
  body.set("target", "en");
  body.set("format", "text");

  let res: Response;
  try {
    res = await fetch(`${TRANSLATE_ENDPOINT}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`Translation request failed: ${err}`);
    return null;
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(`Translation fetch failed: ${res.status} ${errBody.slice(0, 200)}`);
    return null;
  }

  const data = (await res.json()) as TranslateApiResponse;
  const translations = data.data?.translations;
  if (!translations || translations.length !== texts.length) return null;

  // Record actual input length billed, not the pre-call estimate — the
  // two are the same value here (estimatedBytes), but computed
  // independently on purpose so a future change to what gets sent
  // (e.g. URL-encoding overhead) can't silently desync the budget from
  // reality.
  await recordUsage(texts.reduce((sum, t) => sum + byteLength(t), 0)).catch((err) => {
    console.error(`Failed to record translation usage: ${err}`);
  });

  return translations.map((t) => t.translatedText);
}
