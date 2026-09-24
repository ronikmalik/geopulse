// All text consumers use the same answer boundary. Fallback models can
// return thought parts before their answer, and answers can span parts.
// Never publish a thought or accept a safety-blocked/truncated completion.
export function geminiAnswerText(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("candidates" in data) || !Array.isArray(data.candidates)) return null;
  const candidate = data.candidates[0];
  if (!candidate || (candidate.finishReason && candidate.finishReason !== "STOP")) return null;
  const parts = candidate.content?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts
    .filter((part) => part && !part.thought && typeof part.text === "string")
    .map((part) => part.text)
    .join("").trim();
  return text || null;
}
