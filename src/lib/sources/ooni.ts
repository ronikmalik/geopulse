// OONI (Open Observatory of Network Interference) website-blocking
// measurements, aggregated by country (verified live 2026-09-28: one
// request covers every country, ~1 s). https://ooni.org/data/
//
// LICENSE: OONI data is CC BY-NC-SA 4.0 (github.com/ooni/license, data/).
// Non-commercial use only, with attribution, and what GeoPulse derives
// from it (these per-country rates) is shared under the same licence. Fine
// while GeoPulse is non-commercial (it has to be, on Vercel Hobby); a
// commercial GeoPulse would need OONI's permission or a replacement. The
// layer shows the attribution and licence wherever the data appears.
//
// Two numbers, never merged into one, because they mean different things:
//   confirmedRate - share of tests that hit a block page matching a known
//     fingerprint: blocking that is certain, but only where the censor
//     serves a recognisable page (China's firewall mostly does not, so it
//     reads ~0.1% here).
//   anomalyRate - share flagged as possible interference: catches DNS
//     tampering and resets, but includes false positives from bad networks.
// Neither says why a site is blocked: gambling and piracy blocklists count
// the same as political censorship.
const API = "https://api.ooni.io/api/v1/aggregation";
const WINDOW_DAYS = 7;
const MIN_MEASUREMENTS = 500;

export interface OoniCountry {
  country: string; // ISO alpha-2
  measurements: number;
  confirmedRate: number;
  anomalyRate: number;
  // Same measures for the previous 7 days; null when too few tests then.
  confirmedRatePrev: number | null;
  anomalyRatePrev: number | null;
}

export interface OoniSummary {
  since: string;
  until: string;
  countries: OoniCountry[];
  attribution: string;
}

interface AggregationRow {
  probe_cc: string;
  measurement_count: number;
  confirmed_count: number;
  anomaly_count: number;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

async function aggregate(since: Date, until: Date): Promise<AggregationRow[]> {
  const params = new URLSearchParams({
    since: day(since),
    until: day(until),
    axis_x: "probe_cc",
    test_name: "web_connectivity",
  });
  const res = await fetch(`${API}?${params}`, {
    headers: { "User-Agent": "geopulse-globe/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`OONI aggregation: HTTP ${res.status}`);
  const data = (await res.json()) as { result?: AggregationRow[] };
  return data.result ?? [];
}

export function summarizeOoni(current: AggregationRow[], previous: AggregationRow[]): OoniCountry[] {
  const prev = new Map(previous.map((r) => [r.probe_cc, r]));
  return current
    .filter((r) => /^[A-Z]{2}$/.test(r.probe_cc) && r.probe_cc !== "ZZ" && r.measurement_count >= MIN_MEASUREMENTS)
    .map((r) => {
      const p = prev.get(r.probe_cc);
      const prevOk = p && p.measurement_count >= MIN_MEASUREMENTS;
      return {
        country: r.probe_cc,
        measurements: r.measurement_count,
        confirmedRate: r.confirmed_count / r.measurement_count,
        anomalyRate: r.anomaly_count / r.measurement_count,
        confirmedRatePrev: prevOk ? p.confirmed_count / p.measurement_count : null,
        anomalyRatePrev: prevOk ? p.anomaly_count / p.measurement_count : null,
      };
    })
    .sort((a, b) => b.confirmedRate - a.confirmedRate || b.anomalyRate - a.anomalyRate);
}

export async function fetchOoniInterference(now = new Date()): Promise<OoniSummary> {
  const until = new Date(now.getTime());
  const since = new Date(until.getTime() - WINDOW_DAYS * 86_400_000);
  const prevSince = new Date(since.getTime() - WINDOW_DAYS * 86_400_000);
  const [current, previous] = await Promise.all([aggregate(since, until), aggregate(prevSince, since)]);
  return {
    since: day(since),
    until: day(until),
    countries: summarizeOoni(current, previous),
    attribution: "OONI (ooni.org), CC BY-NC-SA 4.0; per-country rates derived by GeoPulse, same licence",
  };
}
