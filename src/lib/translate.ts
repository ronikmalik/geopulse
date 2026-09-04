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
export async function translateBatch(
  texts: string[],
  sourceLang: string,
): Promise<string[] | null> {
  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!apiKey || texts.length === 0) return null;

  const body = new URLSearchParams();
  for (const text of texts) body.append("q", text);
  body.set("source", sourceLang);
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

  return translations.map((t) => t.translatedText);
}
