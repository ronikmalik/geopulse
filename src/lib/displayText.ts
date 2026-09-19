// Display-time cleanup of headline text (2026-09-19). RSS titles and the
// real titles fetched for GDELT items (articleTitleFetch.ts) routinely
// carry the outlet's own branding tail — "… | Middle East Eye", "… - KOCO",
// "… | World | The Guardian" — which is noise on a feed card that already
// shows the source on its own line. This strips it for DISPLAY only; the
// stored row is untouched (the classifier, dedup and embeddings all keep
// seeing the original text, and nothing downstream needs to change).
//
// Deliberately conservative, because a wrong strip mangles a real
// headline: a pipe tail is nearly always an outlet, so any short pipe-
// separated tail goes; a dash tail is ambiguous ("Ukraine - Russia talks
// collapse" is content, "… missile - KOCO" is branding), so it's only
// stripped when the remaining headline is clearly long enough to stand on
// its own AND the tail is short and looks like a name (every word
// capitalised, no sentence punctuation). When in doubt, leave it.
const PIPE_TAIL = /\s+\|\s+([^|]{1,60})$/;
const DASH_TAIL = /\s+[-–—]\s+([^-–—]{1,40})$/;
const MIN_HEAD_WORDS_PIPE = 3;
const MIN_HEAD_WORDS_DASH = 6;
const MAX_DASH_TAIL_WORDS = 4;

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function looksLikeOutletName(tail: string): boolean {
  const words = tail.trim().split(/\s+/);
  if (words.length === 0 || words.length > MAX_DASH_TAIL_WORDS) return false;
  if (/[.!?,:;]/.test(tail)) return false;
  // Every word starts with a capital, a digit (e.g. "Channel 4") or is an
  // acronym — lowercase function words ("the", "of") are tolerated only
  // between capitalised ones so "The Times of Israel" still qualifies.
  const capitalised = words.filter((w) => /^[A-Z0-9]/.test(w)).length;
  return capitalised >= Math.ceil(words.length / 2) && /^[A-Z0-9]/.test(words[0]);
}

export function stripOutletSuffix(text: string): string {
  let out = text.trim();
  // Pipes can stack ("… | World | The Guardian") — peel them one at a time.
  for (let i = 0; i < 3; i++) {
    const m = PIPE_TAIL.exec(out);
    if (!m) break;
    const head = out.slice(0, m.index);
    if (wordCount(head) < MIN_HEAD_WORDS_PIPE) break;
    out = head.trimEnd();
  }
  const d = DASH_TAIL.exec(out);
  if (d) {
    const head = out.slice(0, d.index);
    if (wordCount(head) >= MIN_HEAD_WORDS_DASH && looksLikeOutletName(d[1])) out = head.trimEnd();
  }
  return out;
}
