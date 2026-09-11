import { eq, desc } from "drizzle-orm";
import { getDb } from "@/db";
import { countryBriefs } from "@/db/schema";
import { getCountryRiskEvents, getCountryThreatSummaries } from "./risk";
import { recordAiUsage, canAffordGeminiLiteCall } from "./aiUsage";

// AI-generated situation briefs per active country — see GET
// /api/admin/generate-briefs. NOT piggybacked on the ingest cycle: ingest
// is bound by cron-job.org's hard 30s external-trigger timeout (see the
// comment in src/lib/ingest.ts), which has zero room for even one LLM
// call on top of everything else that cycle already does. This route has
// the standard 55s admin-route budget instead, and its own dedicated
// cadence (see .github/workflows/generate-briefs.yml).
//
// ONE country per invocation (2026-09-11, user request — "50 refreshes
// every day," one call per country, descending pulse/risk-score order).
// Used to loop through up to MAX_COUNTRIES_PER_RUN (15) sequentially in a
// single call — safe at 15, but 50 sequential calls in one 55s-budgeted
// invocation would blow both the wall-clock timeout and the 15 RPM real
// rate limit this model shares with audit/geocode (50 calls in under a
// minute is 3-4x that ceiling). Restructured instead to generate exactly
// ONE brief per call and return immediately: re-rank every active country
// by current score descending, walk down the list, and stop at the FIRST
// one that isn't already fresh (REFRESH_INTERVAL_MS) and has events to
// summarize. Called frequently (~every 15min, same cadence family as
// ingest/review-pending) rather than once/day — each invocation picks up
// wherever the ranked list currently stands, so ~70+ invocations/day
// naturally work down the list in descending-score order, and
// GEMINI_LITE_DAILY_CAPS.brief (50) is what actually stops it for the
// day, not an artificial per-call slice.
//
// Verified live 2026-09-08 against a real key. Two rounds of correction:
// gemini-2.0-flash (original guess) doesn't exist in the current lineup
// at all — 404. gemini-2.5-flash-lite DOES appear in ListModels but a
// live generateContent call against it still 404s with "This model...
// is no longer available to new users. Please update your code to use
// models/gemini-3.5-flash-lite" — ListModels lists a model as knowable,
// not necessarily as callable by every project. gemini-3.5-flash-lite is
// Google's own explicit replacement recommendation from that same error.
const BRIEF_MODEL = process.env.GEMINI_BRIEF_MODEL || "gemini-3.5-flash-lite";
const GENERATE_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${BRIEF_MODEL}:generateContent`;
const REQUEST_TIMEOUT_MS = 20_000;

const MAX_EVENTS_IN_PROMPT = 8;

// Skip a country whose most recent brief is still within this window —
// this is what makes the once-per-country-per-invocation design above
// actually converge on "each active country gets refreshed once a day,"
// not just "the top-ranked country every single cycle": once a country
// gets a fresh brief, it drops out of eligibility for ~20h, so the NEXT
// invocation's re-ranking naturally reaches the next-highest-scoring
// country that still needs one. Slack under 24h so a slightly-early or
// slightly-late cadence firing doesn't skip a day entirely.
const REFRESH_INTERVAL_MS = 20 * 60 * 60_000;

const regionNames =
  typeof Intl !== "undefined" ? new Intl.DisplayNames(["en"], { type: "region" }) : null;

function countryDisplayName(alpha2: string): string {
  try {
    return regionNames?.of(alpha2) ?? alpha2;
  } catch {
    return alpha2;
  }
}

interface PromptEvent {
  title: string;
  severity: number;
  category: string;
  publishedAt: string;
}

// Strict grounding instruction is the load-bearing part — this is a
// geopolitical intelligence product where the user explicitly prioritized
// accuracy (2026-09-05: "prioritize accuracy"), so the brief must never
// read as more authoritative than "a summary of exactly these N
// headlines." No system role in the request (Gemini's REST API takes it
// as a separate systemInstruction field) — folded into the one prompt
// instead to keep this a single simple text-in/text-out call.
function buildPrompt(country: string, events: PromptEvent[]): string {
  const lines = events
    .map((e, i) => `${i + 1}. [severity ${e.severity}/5, ${e.category}] ${e.title}`)
    .join("\n");
  return `You are writing a short, neutral situation brief for a geopolitical risk dashboard about ${countryDisplayName(country)}. Base it STRICTLY on the numbered events below — no outside knowledge, no speculation, nothing not present in this list. If they don't support a coherent narrative, just factually summarize what's listed. Write 2-3 plain-prose sentences. No bullet points, no preamble like "Here is a brief", no markdown formatting.

Events:
${lines}`;
}

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

async function callGemini(prompt: string, apiKey: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`${GENERATE_ENDPOINT}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`Brief generation request failed: ${err}`);
    return null;
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(`Brief generation fetch failed: ${res.status} ${errBody.slice(0, 200)}`);
    return null;
  }
  const data = (await res.json()) as GenerateContentResponse;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return text?.trim() || null;
}

export interface GenerateBriefsResult {
  generated: number;
  skipped: number;
}

export async function generateBriefsForActiveCountries(): Promise<GenerateBriefsResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { generated: 0, skipped: 0 };

  // Checked once, up front, not per-candidate — see this file's own
  // header comment for why this is what actually stops the day at 50
  // rather than an artificial slice of the ranked list.
  if (!(await canAffordGeminiLiteCall("brief"))) return { generated: 0, skipped: 0 };

  const db = getDb();
  const summaries = await getCountryThreatSummaries();
  const active = summaries.filter((s) => s.eventCount > 0).sort((a, b) => b.score - a.score);

  let skipped = 0;

  for (const s of active) {
    try {
      const recent = await db
        .select({ generatedAt: countryBriefs.generatedAt })
        .from(countryBriefs)
        .where(eq(countryBriefs.country, s.country))
        .orderBy(desc(countryBriefs.generatedAt))
        .limit(1);
      if (recent[0] && Date.now() - recent[0].generatedAt.getTime() < REFRESH_INTERVAL_MS) {
        skipped++;
        continue;
      }

      const events = await getCountryRiskEvents(s.country);
      const top = [...events].sort((a, b) => b.weight - a.weight).slice(0, MAX_EVENTS_IN_PROMPT);
      if (top.length === 0) {
        skipped++;
        continue;
      }

      const text = await callGemini(buildPrompt(s.country, top), apiKey);
      if (!text) {
        skipped++;
        continue;
      }

      await db.insert(countryBriefs).values({
        country: s.country,
        briefText: text,
        eventCount: top.length,
        model: BRIEF_MODEL,
      });
      await recordAiUsage("brief", 1);
      // One per invocation — see this file's own header comment. The
      // next call (this cadence fires every ~15min) re-ranks and picks up
      // the next-highest-scoring country that still needs a refresh.
      return { generated: 1, skipped };
    } catch (err) {
      console.error(`generateCountryBrief(${s.country}) failed: ${err}`);
      skipped++;
    }
  }

  // Walked the whole ranked list without finding anything eligible —
  // every active country already has a brief under REFRESH_INTERVAL_MS
  // old, or none have summarizable events. Not an error, just nothing to
  // do this cycle.
  return { generated: 0, skipped };
}

export interface LatestBrief {
  briefText: string;
  eventCount: number;
  generatedAt: string;
}

export async function getLatestCountryBrief(country: string): Promise<LatestBrief | null> {
  const db = getDb();
  const rows = await db
    .select({
      briefText: countryBriefs.briefText,
      eventCount: countryBriefs.eventCount,
      generatedAt: countryBriefs.generatedAt,
    })
    .from(countryBriefs)
    .where(eq(countryBriefs.country, country.toUpperCase()))
    .orderBy(desc(countryBriefs.generatedAt))
    .limit(1);
  if (rows.length === 0) return null;
  return { ...rows[0], generatedAt: rows[0].generatedAt.toISOString() };
}
