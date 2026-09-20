// Formats a quote timestamp for the Forex / Energy & Commodities panels
// (2026-09-20). Shown instead of the word "live": a market quote from an
// hour ago and a daily reference fixing from three days ago are different
// things, and the panel should say which it has. "market" rows are
// intraday quotes (last trade, or last close while the market is shut);
// "reference" rows are once-a-day fixings (ECB, EIA, community mirror).
export function describeAsOf(asOf: string, source: "market" | "reference", now = Date.now()): string {
  const t = new Date(asOf).getTime();
  if (!Number.isFinite(t)) return "";
  const ageMin = Math.max(0, Math.round((now - t) / 60_000));
  if (source === "reference") return `daily fixing, ${asOf.slice(0, 10)}`;
  if (ageMin < 1) return "just now";
  if (ageMin < 60) return `${ageMin} min ago`;
  if (ageMin < 36 * 60) return `${Math.round(ageMin / 60)} h ago`;
  return `last trade ${asOf.slice(0, 10)}`;
}

// The freshest timestamp in a set of rows, for a single panel-level line.
export function newestAsOf<T extends { asOf: string; source: "market" | "reference" }>(rows: T[]): T | null {
  let best: T | null = null;
  for (const r of rows) if (!best || r.asOf > best.asOf) best = r;
  return best;
}
