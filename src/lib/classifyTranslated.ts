import { classifyByKeywords, type ClassifiedItem } from "./classify";
import type { CredibilityLookup } from "./sourceCredibility";
import { resolveCountryFromText } from "./countryNames";
import { byteLength, translateBatch } from "./translate";
import { translationAllowanceNow } from "./translationUsage";
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

// Function words of the languages GDELT's article pages most often arrive
// in, minus any that are also English words ("die", "a", "in", "on"...).
// Measured 2026-11-04: of 3,786 retry candidates in seven days, every one
// read as English when inspected, so the retry was sending English text to
// be "translated" into English, billed at full rate, from the same daily
// pool Telegram's non-English channels depend on.
const FOREIGN_FUNCTION_WORDS = new Set(
  (
    "el la los las del y que por para con una se al su sus lo como más pero sin sobre entre " + // es
    "le les des du et une pour dans sur avec est au aux contre selon cette ces qui ont été " + // fr
    "der das und im mit von ist nicht ein eine auf für bei nach zum zur gegen wird sich dem den " + // de
    "il di che della per gli nel alla dei delle sono è anche " + // it
    "os da do das dos em não uma com pelo pela são " + // pt
    "het een van op voor niet zijn naar ook " + // nl
    "dan yang di ke dari untuk dengan ini itu dalam pada " + // id
    "ve bir ile için bu olarak"
  ).split(" "),
);
const ENGLISH_FUNCTION_WORDS = new Set(
  "the of and to in a is for on that with as by at from has was are will said after over its it be have an this not but who".split(" "),
);

// True when the text is plausibly NOT English: mostly non-Latin script, or
// Latin script carrying more non-English than English function words (two
// distinct ones at least, so a name like "de Blasio" or "La Paz" doesn't
// count). Errs toward "English" — a skipped foreign item costs one missed
// recovery, while a false "foreign" costs budget Telegram needed.
export function looksNonEnglish(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return false;
  const nonAscii = letters.filter((ch) => ch > "\u007f").length;
  if (nonAscii / letters.length >= 0.3) return true;
  const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  const foreign = new Set(words.filter((w) => FOREIGN_FUNCTION_WORDS.has(w)));
  const english = words.filter((w) => ENGLISH_FUNCTION_WORDS.has(w)).length;
  return foreign.size >= 2 && foreign.size > english;
}

export async function retryFailedClassificationsViaTranslation(
  failedItems: RawItem[],
  credibilityMap?: Map<string, CredibilityLookup>,
): Promise<TranslationRetryResult> {
  const eligible = failedItems.filter((item) => {
    const text = `${item.title} ${item.snippet}`;
    return looksNonEnglish(text) && (resolveCountryFromText(item.title) ?? resolveCountryFromText(text));
  });

  if (eligible.length === 0) {
    return { recovered: [], recoveredItems: [], attempted: 0, skipped: false };
  }

  // Send what fits this call's allowance, in arrival order, rather than
  // the whole list: translate.ts refuses any request over the per-call
  // limit outright, and a 20-item batch (6 KB, the median on 2026-11-04)
  // was refused in 41 of 48 cycles, so nothing at all got through.
  const allowance = await translationAllowanceNow().catch(() => 0);
  const candidates: RawItem[] = [];
  const texts: string[] = [];
  let bytes = 0;
  for (const item of eligible) {
    const pair = [item.title.slice(0, MAX_INPUT_CHARS), item.snippet.slice(0, MAX_INPUT_CHARS)];
    const pairBytes = byteLength(pair[0]) + byteLength(pair[1]);
    if (bytes + pairBytes > allowance) continue;
    bytes += pairBytes;
    candidates.push(item);
    texts.push(...pair);
  }
  if (candidates.length === 0) {
    return { recovered: [], recoveredItems: [], attempted: 0, skipped: true };
  }

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
    // 2026-09-28: translation changes the text, not its eligibility for publication.
    const result = classifyByKeywords(translatedItem, credibilityMap);
    if (result) {
      recovered.push(result);
      recoveredItems.push(translatedItem);
    }
  }

  return { recovered, recoveredItems, attempted: candidates.length, skipped: false };
}
