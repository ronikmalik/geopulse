import { eq, desc } from "drizzle-orm";
import { getDb } from "@/db";
import { countryBriefs } from "@/db/schema";
import { getCountryRiskEvents, getCountryThreatSummaries } from "./risk";
import { recordAiUsage } from "./aiUsage";

// Daily AI-generated situation briefs per active country — see GET
// /api/admin/generate-briefs, run once/day by vercel.ts's cron rather
// than piggybacked on the ingest cycle: ingest is bound by cron-job.org's
// hard 30s external-trigger timeout (see the comment in
// src/lib/ingest.ts), which has zero room for N sequential LLM calls.
// This route has the standard 55s admin-route budget instead.
//
// Same model-name uncertainty as embeddings.ts — see that file's comment
// and GET /api/admin/ai-models for the fix if this 404s.
const BRIEF_MODEL = process.env.GEMINI_BRIEF_MODEL || "gemini-2.0-flash";
const GENERATE_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${BRIEF_MODEL}:generateContent`;
const REQUEST_TIMEOUT_MS = 20_000;

// Bounds cost and this route's wall-clock time (sequential calls, 55s
// budget) — not a hard quota, just "how many countries get a fresh brief
// today." Ranked by current score, so coverage always favors whatever's
// actually active over blindly rotating through all ~190 countries,
// most of which have zero events most days anyway (see risk.ts's
// baseline-row comment).
const MAX_COUNTRIES_PER_RUN = 15;
const MAX_EVENTS_IN_PROMPT = 8;

// Skip a country whose most recent brief is still within this window —
// this runs once/day, so anything under ~20h old is today's brief, not a
// stale one. Slack under 24h so a slightly-early or slightly-late cron
// firing doesn't skip a day entirely.
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

  const db = getDb();
  const summaries = await getCountryThreatSummaries();
  const active = summaries
    .filter((s) => s.eventCount > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_COUNTRIES_PER_RUN);

  let generated = 0;
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
      generated++;
    } catch (err) {
      console.error(`generateCountryBrief(${s.country}) failed: ${err}`);
      skipped++;
    }
  }

  return { generated, skipped };
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
