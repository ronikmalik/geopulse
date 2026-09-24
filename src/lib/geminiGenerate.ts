// One way to call Gemini's generateContent, with a fallback model chain
// (2026-09-24, live-caught).
//
// Why: every text caller — the review gate, country briefs, geocoding —
// used a single model, gemini-3.5-flash-lite. From ~12:05 UTC on
// 2026-09-24 that model answered 503 "experiencing high demand" for hours.
// The review gate is the only way a GDELT item gets published (GDELT is
// deliberately never auto-promoted), so GDELT went dark: 41 items stuck,
// no approvals for 2.5 hours, while every run reported success because
// the gate logs a failed call and moves on. The same outage had already
// stopped the brief job on 2026-09-22.
//
// Probed live that afternoon with the production key: 3.5-flash-lite,
// 3.1-flash-lite, the 3.6-3.8 flash models and the "-latest" aliases were
// all 503; 2.5-flash and 2.5-flash-lite are closed to new users (404);
// gemini-3.5-flash answered 200. Free-tier quotas are per model, so a
// fallback also brings its own daily allowance rather than sharing the
// primary's.
//
// Order is: the caller's configured model, then these, skipping repeats.
// 3.5-flash first because it was answering early in the outage;
// 3.1-flash-lite next. Minutes later all three were 503 at once — a
// free-tier-wide capacity problem, not one model — so the last resort is
// outside the Gemini family: gemma-4-26b-a4b-it, Google's open model on
// the same API and key, which kept answering throughout. Probed live with
// the review gate's exact request shape: it accepts systemInstruction and
// JSON mode, returns its reasoning as separate thought parts (which
// callers already discard), and gave valid, sensible JSON. It is slower
// (8-10 s) and a different model from the one the gate was calibrated on,
// hence last — and every review records which model decided
// (events.review_model), so its verdicts can be audited on their own.
// gemma-4-31b-it was also listed but timed out at 30 s.
import { reserveAiCalls, type AiUsageKind } from "./aiUsage";

const FALLBACK_MODELS = ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemma-4-26b-a4b-it"];

// A model that just failed on availability is skipped for this long by
// every later call in the same process, so a review round doesn't pay a
// full timeout on the dead model before every single batch.
const UNAVAILABLE_COOLDOWN_MS = 10 * 60_000;
const unavailableUntil = new Map<string, number>();

// Calls in this process where every model in the chain was unavailable.
// Surfaced in job results so an outage is visible in the run log instead
// of hiding behind "errors": [] (which is exactly how 2026-09-24's went
// unnoticed).
let exhaustedCalls = 0;
export function exhaustedCallCount(): number {
  return exhaustedCalls;
}

export function modelChain(primary: string): string[] {
  return [...new Set([primary, ...FALLBACK_MODELS])];
}

// Statuses that mean "this model can't serve anyone right now", as opposed
// to "this request is wrong". 429 counts: free-tier quotas are per model,
// so another model may well have allowance left.
export function isAvailabilityFailure(status: number): boolean {
  return status === 429 || status >= 500;
}

export type GenerateOutcome =
  | { ok: true; res: Response; model: string }
  // unavailable: every model in the chain failed on availability — worth
  // retrying on a later cycle, not a defect in the request.
  | { ok: false; unavailable: boolean; detail: string };

export async function generateContent(
  primaryModel: string,
  body: unknown,
  apiKey: string,
  timeoutMs: number,
  kind: Exclude<AiUsageKind, "embedding">,
): Promise<GenerateOutcome> {
  const now = Date.now();
  const chain = modelChain(primaryModel);
  // Respect the circuit breaker even when the whole provider is down.
  // Retrying all cooling models for every batch spent quota and runner
  // time while extending the database's awake period during the outage.
  const live = chain.filter((m) => (unavailableUntil.get(m) ?? 0) <= now);
  if (live.length === 0) {
    exhaustedCalls++;
    return { ok: false, unavailable: true, detail: "All models are cooling down; retry on a later cycle" };
  }

  const failures: string[] = [];
  for (const model of live) {
    // Every HTTP attempt, including fallback and timeouts, spends one of
    // the owner's existing daily call allowance. Never spend on a failed
    // reservation, and never refund an ambiguous upstream failure.
    if (!(await reserveAiCalls(kind, 1))) {
      return { ok: false, unavailable: true, detail: `${kind} budget unavailable; request skipped` };
    }
    let res: Response;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        // Header, not ?key=: keeps the key out of any URL that ends up in
        // an error message or log line.
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // A timeout or reset is indistinguishable from overload here.
      unavailableUntil.set(model, Date.now() + UNAVAILABLE_COOLDOWN_MS);
      failures.push(`${model}: ${String(err).slice(0, 120)}`);
      continue;
    }
    if (res.ok) {
      if (model !== primaryModel) console.warn(`gemini: ${primaryModel} unavailable, served by ${model}`);
      return { ok: true, res, model };
    }
    const errBody = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
    if (isAvailabilityFailure(res.status)) {
      unavailableUntil.set(model, Date.now() + UNAVAILABLE_COOLDOWN_MS);
      failures.push(`${model}: ${res.status} ${errBody}`);
      continue;
    }
    // 404: this model has been retired or closed to this key (Google did
    // exactly that to the 2.5 generation). Skip it for good this process
    // and try the next; the chain should outlive any one model.
    if (res.status === 404) {
      unavailableUntil.set(model, Number.POSITIVE_INFINITY);
      failures.push(`${model}: 404 ${errBody}`);
      continue;
    }
    // A 400/403 is about this request or key; the next model would refuse
    // it too, and it needs a human.
    return { ok: false, unavailable: false, detail: `${model}: ${res.status} ${errBody}` };
  }
  exhaustedCalls++;
  return { ok: false, unavailable: true, detail: failures.join(" | ") };
}

// Test hook.
export function resetModelCooldowns(): void {
  unavailableUntil.clear();
}
