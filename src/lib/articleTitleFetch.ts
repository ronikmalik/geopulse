// Fetches the REAL title (and, if available, a real description) directly
// from a source article's own page — added 2026-09-10 after a user-caught
// bug: GDELT bulk items were showing a title synthesized from GDELT's own
// structured CAMEO fields, not the actual headline of the article the card
// linked to, so clicking through showed a completely different real story.
// See pendingGdeltTitle.ts/gdeltBulk.ts's drainPendingGdeltTitles for how
// this is used — a candidate only becomes a real feed item once this
// actually succeeds; a failure leaves it queued for retry, never falls
// back to a guessed title.
const REQUEST_TIMEOUT_MS = 8_000;
// <title> and the description meta tags are always inside <head>, near the
// top of the document — reading the full page (some are multi-MB with
// embedded scripts/images-as-data-URIs) would be needless latency/memory
// for information that's always in the first few KB. Capped read, not a
// full download.
const MAX_BYTES = 200_000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  hellip: "…",
};

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(\w+);/g, (m, name) => NAMED_ENTITIES[name] ?? m);
}

function extractTag(html: string, pattern: RegExp): string | null {
  const match = pattern.exec(html);
  if (!match?.[1]) return null;
  const decoded = decodeHtmlEntities(match[1]).replace(/\s+/g, " ").trim();
  return decoded || null;
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return res.text();

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  reader.cancel().catch(() => {});
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(combined);
}

export interface FetchedArticle {
  title: string;
  snippet: string;
}

// Returns null on any failure (unreachable, timeout, non-2xx, no <title>
// found) — callers must treat that as "not ready yet, try again later",
// never as license to fall back to a guessed title.
export async function fetchRealArticleTitle(url: string): Promise<FetchedArticle | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "geopulse-globe/1.0" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let html: string;
  try {
    html = await readCapped(res, MAX_BYTES);
  } catch {
    return null;
  }

  const title = extractTag(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!title) return null;

  const description =
    extractTag(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i) ??
    extractTag(html, /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:description["']/i) ??
    extractTag(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ??
    extractTag(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);

  return {
    title: title.slice(0, 300),
    // A real snippet is preferred, but its absence isn't a reason to
    // reject an otherwise-real, verified title — falls back to the title
    // itself, same as how a short RSS item with no separate summary
    // already behaves elsewhere in this app.
    snippet: (description ?? title).slice(0, 500),
  };
}
