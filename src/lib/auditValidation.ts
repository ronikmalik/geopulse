import { z } from "zod";
import { COUNTRY_CENTROIDS } from "./countryCentroids";

// Schema-level validation of Gemini's audit/review answers (Codex,
// 2026-09-19). Before this, a malformed entry (wrong types, an id Gemini
// invented, two conflicting answers for one id) could still flow into
// applyPendingAssessment/processKeptCandidates as if it were a real
// verdict. Now anything that doesn't parse is dropped and the item simply
// stays unaudited/pending for the next cycle.
//
// Two deliberate softenings on top of Codex's original strict shape (same
// day): an LLM that AGREES with everything stored will sometimes omit
// `reasoning` entirely rather than send "", and will occasionally emit an
// ISO code this app doesn't model (a territory, a historical code). Both
// used to invalidate the whole answer — which doesn't make the feed any
// safer (the item just gets re-sent to Gemini next cycle, spending another
// call from a hard-capped daily budget) — so `reasoning` defaults to ""
// and an unknown country coerces to null. Null is the safe value: every
// consumer treats it as "no country opinion" and never reassigns anything
// on it. The safety rules that actually matter are unchanged: a
// DISAGREEMENT still requires a non-empty reasoning, duplicates/unknown
// ids are still dropped, and the presstv-US restriction still holds.
const country = z
  .string()
  .nullable()
  .transform((value) => {
    if (typeof value !== "string") return null;
    const code = value.trim().toUpperCase();
    return Object.hasOwn(COUNTRY_CENTROIDS, code) ? code : null;
  });
const severity = z.number().int().min(1).max(5);
const keptSchema = z.object({
  id: z.number().int().positive(),
  validInclusion: z.boolean(),
  severity,
  country,
  reasoning: z.string().max(2000).optional().default(""),
  pattern: z.unknown().optional(),
  lesson: z.unknown().optional(),
});
const droppedSchema = z.object({
  id: z.number().int().positive(),
  reasoning: z.string().trim().min(1).max(2000),
  suggestedSeverity: severity,
  suggestedCountry: country,
  suggestedFix: z.string().max(2000).optional(),
  pattern: z.unknown().optional(),
  lesson: z.unknown().optional(),
});

export type KeptAssessment = z.infer<typeof keptSchema>;
interface AuditCandidate { id: number; country: string | null; severity: number; source: string }

// A missing answer remains unaudited. Conflicting duplicate answers for
// one ID are discarded rather than applied in whichever order Gemini chose.
export function validKeptAssessments(raw: unknown[], candidates: AuditCandidate[]): KeptAssessment[] {
  const counts = new Map<unknown, number>();
  for (const row of raw) {
    if (row && typeof row === "object" && "id" in row) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  }
  return raw.flatMap((row) => {
    const result = keptSchema.safeParse(row);
    if (!result.success) return [];
    const answer = result.data;
    const candidate = candidates.find((item) => item.id === answer.id);
    if (!candidate || counts.get(answer.id) !== 1) return [];
    const disagrees = !answer.validInclusion || answer.severity !== candidate.severity || answer.country !== candidate.country;
    if (disagrees && !answer.reasoning.trim()) return [];
    if (answer.validInclusion && candidate.source === "telegram:presstv" && answer.country === "US") return [];
    return [answer];
  });
}

// This prompt deliberately returns only flagged exclusions. A malformed
// entry makes the response inconclusive; do not mark the whole batch done.
export function validDroppedFindings(raw: unknown[], allowedIds: number[]) {
  const parsed = z.array(droppedSchema).safeParse(raw);
  if (!parsed.success) return null;
  const ids = parsed.data.map((row) => row.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => !allowedIds.includes(id))) return null;
  return parsed.data;
}
