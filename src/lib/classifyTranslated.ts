import { classifyGdeltItem, classifyByKeywords, type ClassifiedItem } from "./classify";
import { resolveCountryFromText } from "./countryNames";
import { translateBatch } from "./translate";
import type { RawItem } from "./sources/gdelt";

// Translation-fallback retry for RSS/GDELT items that fail classification
// in their ORIGINAL language — found live 2026-09-10 auditing why "black
// holes" weren't filling in even after PRIORITY_GDELT_QUERIES grew to 76
// real, researched country queries: classify.ts's severity/incident-
// vocabulary checks (assessIncidentSeverity/keywordSeverity) are pure
// English regex ("captured," "strike," "displaced"...), but GDELT indexes
// news in every language by design. Real, severe stories were being
// scored severity=1 and dropped purely because they were written in
// German/French/Arabic/Chinese/etc — e.g. a live-caught case: a German
// headline reporting Iran capturing a US Navy submarine scored severity 1
// (nothing English matched) while the identical story in English would
// have cleared the bar easily.
//
// Bounded, not a blanket "translate everything" pass — that would burn
// through the 499,000 char/month cap in days given RSS+GDELT's volume,
// unlike Telegram's small curated channel list this budget was originally
// sized for (see translationUsage.ts). Only items that ALREADY show
// independent evidence of being on-topic — resolveCountryFromText finds
// something in the untranslated text — are worth spending translation
// budget on; an item that resolves no country at all is far more likely
// to be genuinely unrelated content than a real story in a language the
// severity regex can't read, and translating it would just be guessing.
//
// Batches every candidate's title+snippet into ONE translateBatch call
// (not one call per item) — cheaper, and keeps this within one ingest
// cycle's time budget the same way GDELT/Telegram's own rotations do.
export interface TranslationRetryResult {
  recovered: ClassifiedItem[];
  recoveredItems: RawItem[]; // same order/index as `recovered` — the item each classification came from (translated title/snippet, for storing a readable row)
  attempted: number;
  skipped: boolean; // true when GOOGLE_TRANSLATE_API_KEY isn't set or the budget check failed — not an error, just nothing to do
}

const MAX_INPUT_CHARS = 500; // title+snippet are already short; caps a single pathological item from claiming a disproportionate share of one call's budget

export async function retryFailedClassificationsViaTranslation(
  failedItems: RawItem[],
  isGdelt: (item: RawItem) => boolean,
): Promise<TranslationRetryResult> {
  const candidates = failedItems.filter((item) => {
    const text = `${item.title} ${item.snippet}`;
    return resolveCountryFromText(item.title) ?? resolveCountryFromText(text);
  });

  if (candidates.length === 0) {
    return { recovered: [], recoveredItems: [], attempted: 0, skipped: false };
  }

  const texts = candidates.flatMap((item) => [
    item.title.slice(0, MAX_INPUT_CHARS),
    item.snippet.slice(0, MAX_INPUT_CHARS),
  ]);
  const translated = await translateBatch(texts, "auto");
  if (!translated) {
    return { recovered: [], recoveredItems: [], attempted: candidates.length, skipped: true };
  }

  const recovered: ClassifiedItem[] = [];
  const recoveredItems: RawItem[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const translatedTitle = translated[i * 2];
    const translatedSnippet = translated[i * 2 + 1];
    if (!translatedTitle || !translatedSnippet) continue; // this one item's slice of the batch came back malformed — skip it, not the whole batch

    const translatedItem: RawItem = { ...candidates[i], title: translatedTitle, snippet: translatedSnippet };
    const result = isGdelt(candidates[i]) ? classifyGdeltItem(translatedItem) : classifyByKeywords(translatedItem);
    if (result) {
      recovered.push(result);
      recoveredItems.push(translatedItem);
    }
  }

  return { recovered, recoveredItems, attempted: candidates.length, skipped: false };
}
